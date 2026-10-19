import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, deliverOutboxRowMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  deliverOutboxRowMock: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: loggerMock,
}));

vi.mock('./outbox-row.js', () => ({
  deliverOutboxRow: deliverOutboxRowMock,
}));

import { logger } from '../lib/logger.js';
import { WebhookDispatcher } from './outbox-dispatcher.js';
import { deliverOutboxRow } from './outbox-row.js';

function createDispatcher(options: Record<string, unknown> = {}) {
  const pool = {
    connect: vi.fn(),
  };

  const dispatcher = new WebhookDispatcher({
    endpointUrl: 'https://example.com/webhook',
    secret: 'test-secret',
    pollIntervalMs: 1000,
    batchSize: 25,
    maxBatchBackoffMs: 5000,
    pool,
    circuitBreakerStore: {} as never,
    ...options,
  });

  return { dispatcher, pool };
}

function createClient(rows: Array<Record<string, unknown>> = []) {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('SELECT')) {
        return { rows };
      }

      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

describe('WebhookDispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts only when the endpoint and secret are configured', () => {
    const { dispatcher } = createDispatcher({ endpointUrl: '', secret: '' });
    const pollSpy = vi.spyOn(dispatcher, 'pollOnce').mockResolvedValue(undefined);

    dispatcher.start();

    expect(pollSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook outbox dispatcher disabled; WEBHOOK_URL and WEBHOOK_SECRET are required'
    );
  });

  it('starts polling and clears the interval when stopped', async () => {
    const { dispatcher } = createDispatcher();
    const pollSpy = vi.spyOn(dispatcher, 'pollOnce').mockResolvedValue(undefined);

    dispatcher.start();
    await dispatcher.stop();

    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect((dispatcher as any).stopped).toBe(true);
  });

  it('coalesces concurrent polls while one batch is already in flight', async () => {
    const { dispatcher } = createDispatcher();
    const processBatchSpy = vi
      .spyOn(dispatcher as any, 'processBatch')
      .mockResolvedValue(undefined);
    (dispatcher as any).inFlight = Promise.resolve();

    await dispatcher.pollOnce();

    expect(processBatchSpy).not.toHaveBeenCalled();
  });

  it('processes the queued rows and commits a successful batch', async () => {
    const row = {
      id: 'row-1',
      stream_id: 'stream-1',
      event_type: 'contract_event',
      payload: { endpointUrl: 'https://example.com/webhook', secret: 'test-secret' },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    };

    const client = createClient([row]);
    const { dispatcher } = createDispatcher({
      pool: {
        connect: vi.fn().mockResolvedValue(client),
      },
    });

    await (dispatcher as any).processBatch();

    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, stream_id, event_type, payload, created_at'),
      [25]
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(deliverOutboxRow).toHaveBeenCalledTimes(1);
    expect(deliverOutboxRow).toHaveBeenCalledWith(
      client,
      row,
      expect.objectContaining({
        endpointUrl: 'https://example.com/webhook',
        secret: 'test-secret',
      })
    );
  });

  it('treats an empty batch as success and resets the failure backoff', async () => {
    const client = createClient([]);
    const { dispatcher } = createDispatcher({
      pool: {
        connect: vi.fn().mockResolvedValue(client),
      },
      batchSize: 0,
    });

    (dispatcher as any).currentBatchBackoffMs = 0;
    (dispatcher as any).consecutiveBatchFailures = 2;

    await (dispatcher as any).processBatch();

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, stream_id, event_type, payload, created_at'),
      [0]
    );
    expect((dispatcher as any).currentBatchBackoffMs).toBe(0);
    expect((dispatcher as any).consecutiveBatchFailures).toBe(0);
    expect(deliverOutboxRow).not.toHaveBeenCalled();
  });

  it('supports zero and maximum batch sizes without altering the query contract', async () => {
    const row = {
      id: 'row-max',
      stream_id: 'stream-max',
      event_type: 'contract_event',
      payload: { endpointUrl: 'https://example.com/webhook', secret: 'test-secret' },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    };

    for (const size of [0, Number.MAX_SAFE_INTEGER]) {
      const client = createClient(size === 0 ? [] : [row]);
      const { dispatcher } = createDispatcher({
        batchSize: size,
        pool: {
          connect: vi.fn().mockResolvedValue(client),
        },
      });

      await (dispatcher as any).processBatch();

      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id, stream_id, event_type, payload, created_at'),
        [size]
      );

      vi.clearAllMocks();
    }
  });

  it('rolls back on a database failure and increases the retry backoff', async () => {
    const error = new Error('db unavailable');
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN') {
          return { rows: [] };
        }

        if (sql.includes('SELECT')) {
          throw error;
        }

        if (sql === 'ROLLBACK') {
          return { rows: [] };
        }

        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const { dispatcher } = createDispatcher({
      pool: { connect: vi.fn().mockResolvedValue(client) },
      pollIntervalMs: 1000,
      maxBatchBackoffMs: 5000,
    });

    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await (dispatcher as any).processBatch();

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(logger.error).toHaveBeenCalledWith(
      'Webhook outbox dispatcher batch failed',
      undefined,
      expect.objectContaining({
        error: 'db unavailable',
      })
    );
    expect((dispatcher as any).consecutiveBatchFailures).toBe(1);
    expect((dispatcher as any).currentBatchBackoffMs).toBe(1000);
  });

  it('waits for the current in-flight work to finish before stopping', async () => {
    const { dispatcher } = createDispatcher();
    let resolveWork!: () => void;

    (dispatcher as any).inFlight = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    const stopPromise = dispatcher.stop();

    expect((dispatcher as any).stopped).toBe(true);

    resolveWork();
    await stopPromise;
  });
});
