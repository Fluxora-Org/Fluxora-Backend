import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
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

describe('WebhookDispatcher outbox polling', () => {
  let redis: FakeRedisClient;
  let breaker: RedisWebhookCircuitBreakerStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    breaker = new RedisWebhookCircuitBreakerStore(redis);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // consumer.example is not a real domain; mock DNS so the SSRF guard passes.
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34'] as any);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));
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
      {
        id: '42',
        stream_id: 'stream-1',
        event_type: 'stream.created',
        payload: { id: 'evt-1', amount: '10' },
        created_at: new Date(),
      },
    ]);
    global.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const select = client.queries.find(q => q.sql.includes('SELECT id, stream_id'));
    expect(select?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(select?.params).toEqual([5]);
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(client.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
          params: ['42'],
        }),
      ]),
    );
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
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
    global.fetch = vi.fn(async () => new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    const insert = client.queries.find(q => q.sql.includes('INSERT INTO webhook_outbox'));
    expect(client.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
          params: ['43'],
        }),
      ]),
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
    global.fetch = vi.fn(async () => new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    await createDispatcher(client, breaker).pollOnce();

    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
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
    const insert = client.queries.find(q => q.sql.includes('INSERT INTO webhook_outbox'));
    expect(insert).toBeDefined();
    expect(insert?.params?.[3]).toEqual(new Date((await breaker.getState('https://consumer.example/webhooks'))!.resetAt));
  });

  it('re-enqueues outbox rows when half-open probe contention blocks delivery', async () => {
    const now = 8_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 2; i++) {
      await breaker.recordFailure('https://consumer.example/webhooks', policy, now);
    }
    const openState = await breaker.getState('https://consumer.example/webhooks');
    await breaker.checkAndClaimAttempt('https://consumer.example/webhooks', policy, openState!.resetAt);

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
    const insert = client.queries.find(q => q.sql.includes('INSERT INTO webhook_outbox'));
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
      async () => new Promise<Response>((resolve) => {
        releaseFetch = () => resolve(new Response(null, { status: 200 }));
      }),
    ) as unknown as typeof fetch;
    const dispatcher = createDispatcher(client, breaker);

    const poll = dispatcher.pollOnce();
    const stopped = dispatcher.stop();

    // The SSRF DNS guard adds async microtasks before fetch is called; allow
    // more iterations than the bare minimum so the test stays deterministic.
    for (let i = 0; i < 100 && !releaseFetch; i += 1) {
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

// ── SSRF guard re-validation at egress ───────────────────────────────────────
//
// These tests verify that deliverRow() calls assertSafeWebhookEndpointWithDns
// immediately before dispatch so that:
//   • private/loopback IP literals are blocked even if they bypassed the sync
//     check that runs at registration time (defense-in-depth)
//   • hostnames that DNS-resolve to private IPs are blocked (rebinding mitigation)
//   • DNS resolution failures are treated as unsafe (fail-closed)
//   • blocked rows are marked processed (no re-poll) and NOT retried
//   • a public URL with clean DNS continues to deliver normally

describe('WebhookDispatcher — SSRF guard in deliverRow', () => {
  let redis: FakeRedisClient;
  let breaker: RedisWebhookCircuitBreakerStore;

  // Helper: build an outbox row with an endpointUrl embedded in its payload
  // so that resolveEndpoint() picks it up over the dispatcher's static URL.
  function rowWithPayloadUrl(id: string, endpointUrl: string) {
    return {
      id,
      stream_id: `stream-ssrf-${id}`,
      event_type: 'stream.created',
      payload: { id: `evt-ssrf-${id}`, endpointUrl },
      created_at: new Date(),
    };
  }

  // Build a dispatcher whose static endpointUrl is a safe public address so
  // that resolveEndpoint() falls through to the payload URL for testing.
  function createSsrfDispatcher(client: MockClient): WebhookDispatcher {
    return new WebhookDispatcher({
      endpointUrl: 'https://consumer.example/webhooks',
      secret: 'test-secret',
      pollIntervalMs: 60_000,
      batchSize: 5,
      policy,
      pool: { connect: vi.fn(async () => client) },
      circuitBreakerStore: breaker,
    });
  }

  beforeEach(() => {
    redis = new FakeRedisClient();
    breaker = new RedisWebhookCircuitBreakerStore(redis);
  });

  afterEach(async () => {
    await breaker.close();
    redis.reset();
    vi.restoreAllMocks();
  });

  it('blocks delivery to a loopback IPv4 address (127.0.0.1) and routes to DLQ', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-1', 'http://127.0.0.1/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    // No DNS mocking needed — IP literal is detected directly.
    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'UPDATE webhook_outbox SET processed = true WHERE id = $1',
          params: ['ssrf-1'],
        }),
      ]),
    );
    // No retry row must be inserted.
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery to a private class-A address (10.0.0.1)', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-2', 'http://10.0.0.1/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-2'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery to the AWS/GCP/Azure metadata endpoint (169.254.169.254)', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-3', 'http://169.254.169.254/latest/meta-data/')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-3'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery to an IPv6 loopback address (::1)', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-4', 'http://[::1]/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-4'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery to an IPv6 ULA address (fc00::1)', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-5', 'http://[fc00::1]/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-5'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery when a public hostname DNS-resolves to a private IP (rebinding simulation)', async () => {
    // Simulate DNS rebinding: attacker.example resolves to 127.0.0.1 at delivery time.
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['127.0.0.1'] as any);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));

    const client = createClient([rowWithPayloadUrl('ssrf-6', 'https://attacker.example/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-6'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery when DNS resolution fails entirely (fail-closed)', async () => {
    // Both A and AAAA resolution fail — hostname unresolvable.
    vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(new Error('ENOTFOUND'));
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENOTFOUND'));

    const client = createClient([rowWithPayloadUrl('ssrf-7', 'https://unresolvable.invalid/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-7'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('allows delivery when a public hostname resolves to a safe external IP', async () => {
    // 93.184.216.34 is the real IP for example.com — clearly public.
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34'] as any);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));

    const client = createClient([rowWithPayloadUrl('ssrf-8', 'https://example.com/hook')]);
    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-8'),
    )).toBe(true);
  });

  it('blocks delivery to a private class-B address (172.16.0.5)', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-9', 'http://172.16.0.5/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-9'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });

  it('blocks delivery to a private class-C address (192.168.1.1)', async () => {
    const client = createClient([rowWithPayloadUrl('ssrf-10', 'http://192.168.1.1/hook')]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createSsrfDispatcher(client).pollOnce();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(client.queries.some(q =>
      q.sql.includes('UPDATE webhook_outbox SET processed = true') && q.params?.includes('ssrf-10'),
    )).toBe(true);
    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
  });
});
