import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PoolExhaustedError } from '../../db/pool.js';
import { streamRepository } from '../../db/repositories/streamRepository.js';
import type { ApiKeyRecord, StreamRecord } from '../../db/types.js';
import * as apiKeyService from '../../lib/apiKey.js';
import { correlationIdMiddleware } from '../../middleware/correlationId.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import {
  _resetLongPollConnectionLimiter,
  getActiveLongPollConnectionCount,
} from '../../streams/longPoll.js';
import {
  _resetSseReplayBufferForTest,
  _resetSseSubscriptionsForTest,
  getLiveSseSubscriberCount,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
} from '../../streams/sseEmitter.js';
import { registerLongPollRoutes } from './longPoll.js';

// The error handler recognizes RPC failures, but this route never calls the RPC client.
vi.mock('../../services/stellar-rpc.js', () => ({
  RpcFallbackExhaustedError: class RpcFallbackExhaustedError extends Error {},
}));

const streamId = 'stream-test';
const endpoint = `/api/streams/${streamId}/poll`;
const apiKey = 'test-reader-key';
const date = '2025-01-01T00:00:00.000Z';

const stream: StreamRecord = {
  id: streamId,
  sender_address: 'test-sender',
  recipient_address: 'test-recipient',
  amount: '1000',
  streamed_amount: '0',
  remaining_amount: '1000',
  rate_per_second: '10',
  start_time: 0,
  end_time: 0,
  status: 'active',
  contract_id: 'test-contract',
  transaction_hash: 'a'.repeat(64),
  event_index: 0,
  created_at: date,
  updated_at: date,
};

const reader: ApiKeyRecord = {
  id: 'test-reader',
  name: 'Test reader',
  keyHash: '',
  salt: '',
  prefix: 'test-rea',
  createdAt: date,
  rotatedAt: null,
  active: true,
  scopes: ['streams:read'],
};

const update = {
  streamId,
  eventId: 'event-test',
  payload: { amount: '100', status: 'active' },
};

describe('GET /api/streams/:id/poll', () => {
  let server: Server;

  function poll() {
    return request(server).get(endpoint).set('X-API-Key', apiKey);
  }

  async function startPoll(timeout: number) {
    const response = poll().query({ timeout }).then((res) => res);
    // Observe transport errors even if an assertion fails before awaiting the response.
    void response.catch(() => {});
    await expect.poll(() => getLiveSseSubscriberCount(streamId)).toBe(1);
    return { response };
  }

  beforeEach(async () => {
    vi.stubEnv('WS_AUTH_REQUIRED', 'false');
    vi.stubEnv('LONG_POLL_MAX_CONNECTIONS_PER_IP', '10');
    vi.stubEnv('LONG_POLL_MAX_CONNECTIONS_PER_API_KEY', '10');
    vi.stubEnv('LONG_POLL_MAX_GLOBAL_CONNECTIONS', '10');
    vi.stubEnv('LONG_POLL_MAX_CONNECTION_DURATION_MS', '30000');
    vi.stubEnv('LONG_POLL_RETRY_AFTER_SECONDS', '15');
    vi.spyOn(apiKeyService, 'findRecordByRawKey').mockImplementation(async (key) =>
      key === apiKey ? reader : undefined,
    );
    vi.spyOn(streamRepository, 'getById').mockResolvedValue(stream);

    const app = express();
    const router = express.Router();
    registerLongPollRoutes(router);
    app.use(correlationIdMiddleware);
    app.use('/api/streams', router);
    app.use(errorHandler);

    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  afterEach(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    _resetSseSubscriptionsForTest();
    _resetSseReplayBufferForTest();
    _resetLongPollConnectionLimiter();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns data: null after the requested timeout and releases the connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { response } = await startPoll(1);

    await vi.advanceTimersByTimeAsync(1000);

    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: null });
    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(getLiveSseSubscriberCount(streamId)).toBe(0);
  });

  it('delivers a live update using the SSE event envelope', async () => {
    const { response } = await startPoll(30);
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, update);

    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { type: 'stream_update', ...update, correlationId: expect.any(String) },
    });
    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(getLiveSseSubscriberCount(streamId)).toBe(0);
  });

  it('returns a validation error for an invalid timeout', async () => {
    const res = await poll().query({ timeout: 'not-a-number' }).expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'timeout must be a positive integer' },
    });
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('rejects a request without an authenticated principal before reading the stream', async () => {
    const res = await request(server).get(endpoint).expect(401);

    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(streamRepository.getById).not.toHaveBeenCalled();
  });

  it('requires the streams:read scope before reading the stream', async () => {
    vi.mocked(apiKeyService.findRecordByRawKey).mockResolvedValue({
      ...reader,
      scopes: ['streams:write'],
    });
    const res = await poll().expect(403);

    expect(res.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(streamRepository.getById).not.toHaveBeenCalled();
  });

  it('returns 429 with a retry hint when the per-IP limit is reached', async () => {
    vi.stubEnv('LONG_POLL_MAX_CONNECTIONS_PER_IP', '1');
    const { response } = await startPoll(30);

    const limited = await poll().expect(429).expect('Retry-After', '15');
    expect(limited.body).toMatchObject({
      success: false,
      error: { code: 'TOO_MANY_REQUESTS', details: { reason: 'per_ip_limit' } },
    });
    expect(streamRepository.getById).toHaveBeenCalledTimes(1);

    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, update);
    expect((await response).status).toBe(200);
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });

  it('maps a repository rejection to a service error and releases the connection', async () => {
    vi.mocked(streamRepository.getById).mockRejectedValue(new PoolExhaustedError());

    const res = await poll().expect(503);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(getActiveLongPollConnectionCount()).toBe(0);
  });
});
