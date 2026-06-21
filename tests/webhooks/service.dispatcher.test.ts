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

function createDispatcher(client: MockClient, breaker: RedisWebhookCircuitBreakerStore): WebhookDispatcher {
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

function readyOutboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '42',
    stream_id: 'stream-1',
    event_type: 'stream.created',
    payload: { id: 'evt-1' },
    created_at: new Date('2026-05-26T12:00:00.000Z'),
    attempt_count: 0,
    next_attempt_at: new Date('2026-05-26T12:00:00.000Z'),
    ...overrides,
  };
}

function findUpdate(client: MockClient, fragment: string): { sql: string; params: unknown[] | undefined } | undefined {
  return client.queries.find(q => q.sql.includes('UPDATE webhook_outbox') && q.sql.includes(fragment));
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
    expect(client.queries.some(q => q.sql.includes('COMMIT'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('claims rows with FOR UPDATE SKIP LOCKED and marks successful deliveries processed', async () => {
    const client = createClient([
      readyOutboxRow({ payload: { id: 'evt-1', amount: '10' } }),
    ]);
    global.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const select = client.queries.find(q => q.sql.includes('SELECT id, stream_id'));
    expect(select?.sql).toContain('attempt_count, next_attempt_at');
    expect(select?.sql).toContain('next_attempt_at <= NOW()');
    expect(select?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(select?.params).toEqual([5]);
    expect(global.fetch).toHaveBeenCalledOnce();
    const update = findUpdate(client, 'processed = true');
    expect(update?.sql).toContain('attempt_count = $2');
    expect(update?.sql).toContain('next_attempt_at = NULL');
    expect(update?.params).toEqual(['42', 1]);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('persists failed attempt checkpoints on the same outbox row', async () => {
    const now = new Date('2026-05-26T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const client = createClient([
      readyOutboxRow({
        id: '43',
        stream_id: 'stream-2',
        event_type: 'stream.updated',
        payload: { id: 'evt-2', amount: '20' },
        created_at: new Date(now),
      }),
    ]);
    global.fetch = vi.fn(async () => new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const update = findUpdate(client, 'attempt_count = $2');
    expect(update?.sql).toContain('next_attempt_at = $3');
    expect(update?.sql).toContain('processed = false');
    expect(update?.params?.[0]).toBe('43');
    expect(update?.params?.[1]).toBe(1);
    expect(update?.params?.[2]).toEqual(new Date(now + 1000));
    expect(JSON.parse(update?.params?.[3] as string)).toMatchObject({
      id: 'evt-2',
      _webhookRetry: { attemptNumber: 2 },
    });
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('recovers pending retries after restart from durable attempt_count and next_attempt_at', async () => {
    const now = new Date('2026-05-26T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const client = createClient([
      readyOutboxRow({
        id: '44',
        stream_id: 'stream-3',
        event_type: 'stream.cancelled',
        payload: { id: 'evt-3', _webhookRetry: { attemptNumber: 2 } },
        created_at: new Date(now - 60_000),
        attempt_count: 1,
        next_attempt_at: new Date(now - 1),
      }),
    ]);
    global.fetch = vi.fn(async () => new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const update = findUpdate(client, 'attempt_count = $2');
    expect(update?.params?.[1]).toBe(2);
    expect(JSON.parse(update?.params?.[3] as string)).toMatchObject({
      _webhookRetry: { attemptNumber: 3 },
    });
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('routes exhausted outbox rows durably to the dead-letter queue', async () => {
    const client = createClient([
      readyOutboxRow({
        id: '48',
        stream_id: 'stream-7',
        event_type: 'stream.cancelled',
        payload: { id: 'evt-7' },
        attempt_count: 2,
      }),
    ]);
    global.fetch = vi.fn(async () => new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const dlqInsert = client.queries.find(q => q.sql.includes('INSERT INTO dead_letter_queue'));
    expect(dlqInsert?.params?.[0]).toBe('webhook-outbox-48');
    expect(dlqInsert?.params?.[1]).toBe('stream.cancelled');
    expect(JSON.parse(dlqInsert?.params?.[2] as string)).toMatchObject({ id: 'evt-7' });
    expect(dlqInsert?.params?.[3]).toBe('HTTP 500 after 3 attempts');
    expect(dlqInsert?.params?.[4]).toBe(3);

    const update = findUpdate(client, 'processed = true');
    expect(update?.params).toEqual(['48', 3]);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('defers delivery when the shared Redis circuit breaker is open', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await breaker.recordFailure('https://consumer.example/webhooks', policy, now);
    await breaker.recordFailure('https://consumer.example/webhooks', policy, now + 1);

    const client = createClient([
      readyOutboxRow({
        id: '46',
        stream_id: 'stream-5',
        event_type: 'stream.created',
        payload: { id: 'evt-5' },
        created_at: new Date(now),
      }),
    ]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    const update = findUpdate(client, 'next_attempt_at = $2');
    expect(update?.params?.[0]).toBe('46');
    expect(update?.params?.[1]).toEqual(new Date((await breaker.getState('https://consumer.example/webhooks'))!.resetAt));
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('defers the same outbox row when half-open probe contention blocks delivery', async () => {
    const now = 8_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 2; i++) {
      await breaker.recordFailure('https://consumer.example/webhooks', policy, now);
    }
    const openState = await breaker.getState('https://consumer.example/webhooks');
    await breaker.checkAndClaimAttempt('https://consumer.example/webhooks', policy, openState!.resetAt);

    const client = createClient([
      readyOutboxRow({
        id: '47',
        stream_id: 'stream-6',
        event_type: 'stream.created',
        payload: { id: 'evt-6' },
        created_at: new Date(now),
      }),
    ]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    const update = findUpdate(client, 'next_attempt_at = $2');
    expect(update?.params?.[0]).toBe('47');
    expect(update?.params?.[1]).toEqual(new Date(now + 1_000));
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('drains an in-flight delivery when stopped during shutdown', async () => {
    let releaseFetch: (() => void) | undefined;
    const client = createClient([
      readyOutboxRow({
        id: '45',
        stream_id: 'stream-4',
        event_type: 'stream.created',
        payload: { id: 'evt-4' },
        created_at: new Date(),
      }),
    ]);
    global.fetch = vi.fn(
      async () => new Promise<Response>((resolve) => {
        releaseFetch = () => resolve(new Response(null, { status: 200 }));
      }),
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
    expect(client.queries.some(q => q.sql.includes('COMMIT'))).toBe(true);
  });
});
