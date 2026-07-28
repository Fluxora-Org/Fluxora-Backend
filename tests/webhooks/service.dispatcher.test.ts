import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../../src/webhooks/service.js';
import type { EnhancedRetryPolicy } from '../../src/webhooks/retry.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import { RedisWebhookCircuitBreakerStore } from '../../src/redis/webhookCircuitBreakerStore.js';

interface MockClient {
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  rows: unknown[];
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

const policy: EnhancedRetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 1000,
  backoffMultiplier: 1,
  maxBackoffMs: 1000,
  jitterPercent: 0,
  timeoutMs: 1000,
  retryableStatusCodes: [500],
  circuitBreakerThreshold: 2,
  circuitBreakerResetMs: 60_000,
};

function createClient(rows: unknown[]): MockClient {
  const client: MockClient = {
    queries: [],
    rows,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('SELECT id, stream_id')) {
        return { rows: client.rows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  return client;
}

function createDispatcher(
  client: MockClient,
  breaker: RedisWebhookCircuitBreakerStore
): WebhookDispatcher {
  return new WebhookDispatcher({
    endpointUrl: 'https://consumer.example/webhooks',
    secret: 'test-secret',
    pollIntervalMs: 60_000,
    batchSize: 5,
    policy,
    pool: {
      connect: vi.fn(async () => client),
    },
    circuitBreakerStore: breaker,
  });
}

describe('WebhookDispatcher outbox polling', () => {
  let redis: FakeRedisClient;
  let breaker: RedisWebhookCircuitBreakerStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    breaker = new RedisWebhookCircuitBreakerStore(redis);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(async () => {
    await breaker.close();
    redis.reset();
    vi.restoreAllMocks();
  });

  it('no-ops cleanly when the outbox is empty', async () => {
    const client = createClient([]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some((q) => q.sql.includes('COMMIT'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('claims rows with FOR UPDATE SKIP LOCKED and marks successful deliveries processed', async () => {
    const client = createClient([
      {
        id: '42',
        stream_id: 'stream-1',
        event_type: 'stream.created',
        payload: { id: 'evt-1', amount: '10' },
        created_at: new Date(),
      },
    ]);
    global.fetch = vi.fn(
      async () => new Response(null, { status: 204 })
    ) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const select = client.queries.find((q) => q.sql.includes('SELECT id, stream_id'));
    expect(select?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(select?.params).toEqual([5]);
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(client.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
          params: ['42'],
        }),
      ])
    );
    expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('marks failed attempts processed and delegates retry scheduling to a future outbox row', async () => {
    const now = new Date('2026-05-26T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const client = createClient([
      {
        id: '43',
        stream_id: 'stream-2',
        event_type: 'stream.updated',
        payload: { id: 'evt-2', amount: '20' },
        created_at: new Date(now),
      },
    ]);
    global.fetch = vi.fn(
      async () => new Response(null, { status: 500, statusText: 'Server Error' })
    ) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO webhook_outbox'));
    expect(client.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
          params: ['43'],
        }),
      ])
    );
    expect(insert?.params?.[0]).toBe('stream-2');
    expect(insert?.params?.[1]).toBe('stream.updated');
    expect(JSON.parse(insert?.params?.[2] as string)).toMatchObject({
      id: 'evt-2',
      _webhookRetry: { attemptNumber: 2 },
    });
    expect(insert?.params?.[3]).toEqual(new Date(now + 1000));
  });

  it('does not enqueue another row after retry attempts are exhausted', async () => {
    const client = createClient([
      {
        id: '44',
        stream_id: 'stream-3',
        event_type: 'stream.cancelled',
        payload: {
          id: 'evt-3',
          _webhookRetry: { attemptNumber: 3 },
        },
        created_at: new Date(),
      },
    ]);
    global.fetch = vi.fn(
      async () => new Response(null, { status: 500, statusText: 'Server Error' })
    ) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('defers delivery when the shared Redis circuit breaker is open', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await breaker.recordFailure('https://consumer.example/webhooks', policy, now);
    await breaker.recordFailure('https://consumer.example/webhooks', policy, now + 1);

    const client = createClient([
      {
        id: '46',
        stream_id: 'stream-5',
        event_type: 'stream.created',
        payload: { id: 'evt-5' },
        created_at: new Date(now),
      },
    ]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO webhook_outbox'));
    expect(insert).toBeDefined();
    expect(insert?.params?.[3]).toEqual(
      new Date((await breaker.getState('https://consumer.example/webhooks'))!.resetAt)
    );
  });

  it('re-enqueues outbox rows when half-open probe contention blocks delivery', async () => {
    const now = 8_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 2; i++) {
      await breaker.recordFailure('https://consumer.example/webhooks', policy, now);
    }
    const openState = await breaker.getState('https://consumer.example/webhooks');
    await breaker.checkAndClaimAttempt(
      'https://consumer.example/webhooks',
      policy,
      openState!.resetAt
    );

    const client = createClient([
      {
        id: '47',
        stream_id: 'stream-6',
        event_type: 'stream.created',
        payload: { id: 'evt-6' },
        created_at: new Date(now),
      },
    ]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO webhook_outbox'));
    expect(insert).toBeDefined();
    expect(insert?.params?.[3]).toEqual(new Date(now + 1_000));
  });

  it('drains an in-flight delivery when stopped during shutdown', async () => {
    let releaseFetch: (() => void) | undefined;
    const client = createClient([
      {
        id: '45',
        stream_id: 'stream-4',
        event_type: 'stream.created',
        payload: { id: 'evt-4' },
        created_at: new Date(),
      },
    ]);
    global.fetch = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () => resolve(new Response(null, { status: 200 }));
        })
    ) as unknown as typeof fetch;
    const dispatcher = createDispatcher(client, breaker);

    const poll = dispatcher.pollOnce();
    const stopped = dispatcher.stop();

    for (let i = 0; i < 10 && !releaseFetch; i += 1) {
      await Promise.resolve();
    }
    expect(releaseFetch).toBeDefined();
    while (!releaseFetch) {
      await Promise.resolve();
    }
    expect(client.release).not.toHaveBeenCalled();
    releaseFetch();

    await Promise.all([poll, stopped]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.queries.some((q) => q.sql.includes('COMMIT'))).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Poison Payload Detection Tests
  // ─────────────────────────────────────────────────────────────────────

  describe('poison payload detection', () => {
    it('fast-tracks structurally invalid JSON payload to DLQ without retrying', async () => {
      const client = createClient([
        {
          id: 'poison-json-1',
          stream_id: 'stream-poison-1',
          event_type: 'stream.created',
          payload: '{"invalid": json without closing brace',
          created_at: new Date(),
        },
      ]);
      global.fetch = vi.fn() as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      // Should NOT call fetch because payload is marked as poison
      expect(global.fetch).not.toHaveBeenCalled();

      // Should mark original row as processed (no retry enqueued)
      expect(client.queries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
            params: ['poison-json-1'],
          }),
        ])
      );

      // Should NOT insert retry row
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });

    it('fast-tracks oversized payload (>10MB) to DLQ without retrying', async () => {
      const hugePayload = 'x'.repeat(11 * 1024 * 1024); // 11MB string
      const client = createClient([
        {
          id: 'poison-oversized-1',
          stream_id: 'stream-poison-2',
          event_type: 'stream.created',
          payload: hugePayload,
          created_at: new Date(),
        },
      ]);
      global.fetch = vi.fn() as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(client.queries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
            params: ['poison-oversized-1'],
          }),
        ])
      );
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });

    it('fast-tracks binary garbage payload to DLQ without retrying', async () => {
      // Create payload with non-UTF8 binary characters
      const binaryGarbage = String.fromCharCode(0x80, 0x81, 0x82, 0x83) + 'x'.repeat(1001);
      const client = createClient([
        {
          id: 'poison-binary-1',
          stream_id: 'stream-poison-3',
          event_type: 'stream.updated',
          payload: binaryGarbage,
          created_at: new Date(),
        },
      ]);
      global.fetch = vi.fn() as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(client.queries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
            params: ['poison-binary-1'],
          }),
        ])
      );
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });

    it('detects non-retryable 4xx status code as poison on first attempt', async () => {
      const client = createClient([
        {
          id: 'poison-404-1',
          stream_id: 'stream-poison-4',
          event_type: 'stream.created',
          payload: { id: 'evt-404', data: 'test' },
          created_at: new Date(),
        },
      ]);

      // Mock fetch to return 404 (not found - poison)
      global.fetch = vi.fn(
        async () => new Response(null, { status: 404 })
      ) as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      // Should call fetch once (attempt delivery)
      expect(global.fetch).toHaveBeenCalledOnce();

      // Should mark original row as processed
      expect(client.queries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
            params: ['poison-404-1'],
          }),
        ])
      );

      // Should NOT enqueue retry (poison detected)
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });

    it('detects 401 (Unauthorized) as poison', async () => {
      const client = createClient([
        {
          id: 'poison-401-1',
          stream_id: 'stream-poison-5',
          event_type: 'stream.cancelled',
          payload: { id: 'evt-401', data: 'test' },
          created_at: new Date(),
        },
      ]);

      global.fetch = vi.fn(
        async () => new Response(null, { status: 401 })
      ) as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });

    it('detects 403 (Forbidden) as poison', async () => {
      const client = createClient([
        {
          id: 'poison-403-1',
          stream_id: 'stream-poison-6',
          event_type: 'stream.created',
          payload: { id: 'evt-403', data: 'test' },
          created_at: new Date(),
        },
      ]);

      global.fetch = vi.fn(
        async () => new Response(null, { status: 403 })
      ) as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });

    it('still retries on transient 5xx errors', async () => {
      const now = new Date('2026-05-26T12:00:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const client = createClient([
        {
          id: 'transient-500-1',
          stream_id: 'stream-transient-1',
          event_type: 'stream.created',
          payload: { id: 'evt-500', data: 'test' },
          created_at: new Date(now),
        },
      ]);

      // Return 500 (retryable)
      global.fetch = vi.fn(
        async () => new Response(null, { status: 500 })
      ) as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      expect(global.fetch).toHaveBeenCalledOnce();

      // Should enqueue retry (500 is in retryableStatusCodes for this policy)
      const insert = client.queries.find((q) => q.sql.includes('INSERT INTO webhook_outbox'));
      expect(insert).toBeDefined();
      expect(insert?.params?.[1]).toBe('stream.created');
    });

    it('still retries on transient 429 (rate limit) errors', async () => {
      const now = new Date('2026-05-26T12:00:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const client = createClient([
        {
          id: 'transient-429-1',
          stream_id: 'stream-transient-2',
          event_type: 'stream.updated',
          payload: { id: 'evt-429', data: 'test' },
          created_at: new Date(now),
        },
      ]);

      global.fetch = vi.fn(
        async () => new Response(null, { status: 429 })
      ) as unknown as typeof fetch;

      const poisonPolicy: EnhancedRetryPolicy = {
        ...policy,
        retryableStatusCodes: [408, 425, 429, 500, 502, 503, 504],
      };

      const dispatcher = new WebhookDispatcher({
        endpointUrl: 'https://consumer.example/webhooks',
        secret: 'test-secret',
        pollIntervalMs: 60_000,
        batchSize: 5,
        policy: poisonPolicy,
        pool: {
          connect: vi.fn(async () => client),
        },
        circuitBreakerStore: breaker,
      });

      await dispatcher.pollOnce();

      expect(global.fetch).toHaveBeenCalledOnce();

      // Should enqueue retry (429 is retryable)
      const insert = client.queries.find((q) => q.sql.includes('INSERT INTO webhook_outbox'));
      expect(insert).toBeDefined();
    });

    it('succeeds normally when response is 2xx', async () => {
      const client = createClient([
        {
          id: 'success-200-1',
          stream_id: 'stream-success-1',
          event_type: 'stream.created',
          payload: { id: 'evt-200', data: 'test' },
          created_at: new Date(),
        },
      ]);

      global.fetch = vi.fn(
        async () => new Response(null, { status: 200 })
      ) as unknown as typeof fetch;

      const dispatcher = createDispatcher(client, breaker);
      await dispatcher.pollOnce();

      expect(global.fetch).toHaveBeenCalledOnce();

      // Should NOT enqueue retry
      expect(client.queries.some((q) => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
    });
  });
});
