import { initializeConfig } from '../../src/config/env.js';
initializeConfig();

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createServer } from 'http';
import http from 'http';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http';
import { createApp } from '../../src/app.js';
import {
  _resetSseSubscriptionsForTest,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
} from '../../src/streams/sseEmitter.js';
import { generateToken } from '../../src/lib/auth.js';
import {
  _resetSseConnectionLimiter,
  getActiveSseConnectionCount,
} from '../../src/streams/sseConnectionLimiter.js';
import {
  sseSubscriberErrorsTotal,
} from '../../src/metrics/businessMetrics.js';

const mockGetById = vi.fn();

vi.mock('ioredis', () => {
  class RedisMock {
    on = vi.fn();
    quit = vi.fn().mockResolvedValue('OK');
    disconnect = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
  }
  return {
    default: RedisMock,
    Redis: RedisMock,
  };
});

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: (...a: unknown[]) => mockGetById(...a),
  },
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) {
      super(d ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
  QueryTimeoutError: class QueryTimeoutError extends Error {
    constructor() {
      super('query timeout');
      this.name = 'QueryTimeoutError';
    }
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    stellar: {
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      timeout: 10000,
      retry: { maxRetries: 3, initialDelayMs: 1000 },
    },
    database: {
      url: process.env.DATABASE_URL || 'postgresql://localhost:5432/indexer_db',
    },
    indexer: {
      replayBatchSize: 1000,
    },
    server: {
      port: 3000,
    },
  },
}));

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TEST_TOKEN = generateToken({ address: VALID_SENDER, role: 'operator' });

const app = createApp();

type OpenSseConnection = {
  req: ClientRequest;
  res: IncomingMessage;
  data: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDbRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stream-abc123-0',
    sender_address: VALID_SENDER,
    recipient_address:
      'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
    amount: '1000',
    streamed_amount: '0',
    remaining_amount: '1000',
    rate_per_second: '10',
    start_time: 1700000000,
    end_time: 0,
    status: 'active',
    contract_id: 'api-created',
    transaction_hash: 'a'.repeat(64),
    event_index: 0,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function getMetricValue(
  metric: { get: () => any },
  labels: Record<string, string> = {},
): Promise<number> {
  const snapshot = await metric.get();
  const matchingValue = snapshot.values.find((v: any) =>
    Object.entries(labels).every(([k, expected]) => String(v.labels[k]) === expected),
  );
  return matchingValue?.value ?? 0;
}

describe('SSE subscriber observability', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.WS_AUTH_REQUIRED = 'false';
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '10';
    process.env.SSE_MAX_GLOBAL_CONNECTIONS = '1000';
    process.env.SSE_MAX_CONNECTION_DURATION_MS = String(30 * 60 * 1000);
    process.env.SSE_RETRY_AFTER_SECONDS = '15';

    _resetSseConnectionLimiter();
    _resetSseSubscriptionsForTest();

    mockGetById.mockResolvedValue(makeDbRecord({ id: 'stream-123' }));

    // Create a real server to correctly test streaming
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetSseConnectionLimiter();
    _resetSseSubscriptionsForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sseEventBus.removeAllListeners(SSE_STREAM_UPDATE_EVENT);
  });

  it('logs + meters thrown SSE subscriber callbacks while isolating other subscribers', async () => {
    const before = await getMetricValue(sseSubscriberErrorsTotal, { reason: 'subscriber_callback_throw' });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const throwingSubscriber = () => {
      throw new Error('kaboom');
    };

    const healthyRan = { value: false };
    const healthySubscriber = () => {
      healthyRan.value = true;
    };

    // Register both callbacks directly via the emitter subscription mechanism.
    // We use the route endpoint only to ensure SSE stack is active and isolation path is exercised.
    //
    // Note: the route handler wires subscribeToSseStream per active SSE connection.
    // Here we directly attach subscribers to the emitter by calling sseEventBus.emit once connected.
    // The failing subscriber must be attached to the live fan-out path.
    //
    // We attach subscribers to the same streamId used by the event.
    const streamId = 'stream-123';

    // Attach callbacks to the in-memory fan-out directly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { subscribeToSseStream } = await import('../../src/streams/sseEmitter.js');
    const unsubThrow = subscribeToSseStream(streamId, throwingSubscriber as any);
    const unsubHealthy = subscribeToSseStream(streamId, healthySubscriber as any);

    try {
      // Trigger fan-out.
      sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
        streamId,
        eventId: 'evt-1',
        payload: { secret: 'DO_NOT_LOG' },
      });

      // Allow sync logging/metrics to run.
      await delay(10);

      expect(healthyRan.value).toBe(true);

      const after = await getMetricValue(sseSubscriberErrorsTotal, { reason: 'subscriber_callback_throw' });
      expect(after).toBe(before + 1);

      // Structured log should be emitted via logger.error -> process.stderr.write
      expect(stderrSpy).toHaveBeenCalled();
      const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const matchingCall = stderrCalls.find((line) => line.includes('SSE subscriber callback threw'));
      expect(matchingCall).toBeDefined();

      const parsed = JSON.parse(matchingCall!);
      expect(parsed.streamId).toBe(streamId);
      expect(parsed.subscriberError?.name).toBe('Error');
      expect(parsed.subscriberError?.message).toBe('kaboom');

      // Security: ensure SSE payload isn't present in the log entry
      const lineStr = matchingCall!;
      expect(lineStr).not.toContain('DO_NOT_LOG');
      expect(lineStr).not.toContain('payload');
    } finally {
      unsubThrow();
      unsubHealthy();
    }

    // sanity: SSE slot not leaked by direct subscriber registration
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('threads correlationId into logger.error when provided on event', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const throwingSubscriber = () => {
      throw new Error('callback error with correlation');
    };

    const streamId = 'stream-corr-456';
    const correlationId = 'test-correlation-id-789';

    const { subscribeToSseStream } = await import('../../src/streams/sseEmitter.js');
    const unsub = subscribeToSseStream(streamId, throwingSubscriber as any);

    try {
      sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
        streamId,
        eventId: 'evt-2',
        payload: { test: true },
        correlationId,
      });

      await delay(10);

      const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const matchingCall = stderrCalls.find((line) => line.includes('SSE subscriber callback threw'));
      expect(matchingCall).toBeDefined();

      const parsed = JSON.parse(matchingCall!);
      expect(parsed.streamId).toBe(streamId);
      expect(parsed.correlationId).toBe(correlationId);
      expect(parsed.subscriberError?.message).toBe('callback error with correlation');
    } finally {
      unsub();
    }
  });
});

