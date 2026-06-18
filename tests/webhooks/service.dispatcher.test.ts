import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../../src/webhooks/service.js';
import type { WebhookRetryPolicy } from '../../src/webhooks/types.js';

interface MockClient {
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  rows: unknown[];
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

const policy: WebhookRetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 1000,
  backoffMultiplier: 1,
  maxBackoffMs: 1000,
  jitterPercent: 0,
  timeoutMs: 1000,
  retryableStatusCodes: [500],
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

function createDispatcher(client: MockClient): WebhookDispatcher {
  return new WebhookDispatcher({
    endpointUrl: 'https://consumer.example/webhooks',
    secret: 'test-secret',
    pollIntervalMs: 60_000,
    batchSize: 5,
    policy,
    pool: {
      connect: vi.fn(async () => client),
    },
  });
}

describe('WebhookDispatcher outbox polling', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no-ops cleanly when the outbox is empty', async () => {
    const client = createClient([]);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await createDispatcher(client).pollOnce();

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

    await createDispatcher(client).pollOnce();

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

    await createDispatcher(client).pollOnce();

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

    await createDispatcher(client).pollOnce();

    expect(client.queries.some(q => q.sql.includes('INSERT INTO webhook_outbox'))).toBe(false);
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
    const dispatcher = createDispatcher(client);

    const poll = dispatcher.pollOnce();
    const stopped = dispatcher.stop();

    await Promise.resolve();
    expect(client.release).not.toHaveBeenCalled();
    releaseFetch?.();

    await Promise.all([poll, stopped]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.queries.some(q => q.sql.includes('COMMIT'))).toBe(true);
  });
});
