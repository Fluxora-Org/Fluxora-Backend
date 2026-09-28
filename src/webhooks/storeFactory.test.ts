/**
 * Tests for the webhook delivery store selection rule (issue #1528).
 *
 * `src/webhooks/storeFactory.ts` selects between `WebhookDeliveryStore`
 * (in-memory) and `PgWebhookDeliveryStore` (Postgres) based on
 * `WEBHOOK_DELIVERY_STORE`. These tests pin down the documented selection rule,
 * the startup log, the production warning, the fail-safe fallback to memory, and
 * that factory-selected stores remain observably interchangeable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../lib/logger.js';
import { WebhookDeliveryStore, type IWebhookDeliveryStore } from './store.js';
import { PgWebhookDeliveryStore } from './pgStore.js';
import type { WebhookDelivery } from './types.js';
import {
  createWebhookDeliveryStore,
  resolveStoreBackend,
  WEBHOOK_DELIVERY_STORE_ENV,
  type StoreBackend,
} from './storeFactory.js';

function makePool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as import('pg').Pool;
}

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'd1',
    deliveryId: 'deliv1',
    eventId: 'evt1',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/hook',
    status: 'pending',
    attempts: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    payload: '{"equivalence":true}',
    ...overrides,
  };
}

/** Deterministic observable projection used to compare store implementations. */
function observe(store: IWebhookDeliveryStore) {
  store.store(makeDelivery());
  const outboxId = store.addToOutbox({
    deliveryId: 'deliv1',
    eventId: 'evt1',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/hook',
    payload: '{}',
    secret: 'secret-abc',
    priority: 'normal',
    createdAt: 1_700_000_000_000,
    scheduledFor: 1_700_000_000_000 - 1000,
    attempts: 0,
    maxAttempts: 5,
  });

  return {
    deliveryStatus: store.get('d1')?.status,
    byDeliveryId: store.getByDeliveryId('deliv1')?.id,
    duplicate: store.isDuplicateDelivery('deliv1'),
    outboxIdPrefix: outboxId.startsWith('outbox_'),
    outbox: store.getAllOutboxItems().map((i) => ({
      deliveryId: i.deliveryId,
      status: i.status,
      priority: i.priority,
    })),
    metrics: store.getMetrics(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveStoreBackend — the documented selection rule', () => {
  const cases: Array<[string | undefined, StoreBackend]> = [
    [undefined, 'memory'],
    ['', 'memory'],
    ['   ', 'memory'],
    ['memory', 'memory'],
    ['MEMORY', 'memory'],
    ['  Memory  ', 'memory'],
    ['postgres', 'postgres'],
    ['POSTGRES', 'postgres'],
    ['  Postgres  ', 'postgres'],
    // Unrecognised values must never silently disable the memory default.
    ['postgresql', 'memory'],
    ['pg', 'memory'],
    ['sqlite', 'memory'],
  ];

  it.each(cases)('maps %j to %j', (raw, expected) => {
    expect(resolveStoreBackend(raw)).toBe(expected);
  });

  it('reads WEBHOOK_DELIVERY_STORE when no value is supplied', () => {
    const previous = process.env[WEBHOOK_DELIVERY_STORE_ENV];
    try {
      process.env[WEBHOOK_DELIVERY_STORE_ENV] = 'postgres';
      expect(resolveStoreBackend()).toBe('postgres');

      delete process.env[WEBHOOK_DELIVERY_STORE_ENV];
      expect(resolveStoreBackend()).toBe('memory');
    } finally {
      if (previous === undefined) {
        delete process.env[WEBHOOK_DELIVERY_STORE_ENV];
      } else {
        process.env[WEBHOOK_DELIVERY_STORE_ENV] = previous;
      }
    }
  });
});

describe('createWebhookDeliveryStore — selection and startup logging', () => {
  it('selects the in-memory store and logs the active backend', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const store = createWebhookDeliveryStore({ backend: 'memory', nodeEnv: 'development' });

    expect(store).toBeInstanceOf(WebhookDeliveryStore);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('in-memory implementation'),
      undefined,
      expect.objectContaining({ backend: 'memory', durable: false, store: 'WebhookDeliveryStore' })
    );
  });

  it('selects the Postgres-backed store and logs the active backend', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const pool = makePool();

    const store = createWebhookDeliveryStore({
      backend: 'postgres',
      nodeEnv: 'production',
      pool,
      createPostgresStore: (p) => new PgWebhookDeliveryStore(p as import('pg').Pool),
    });

    expect(store).toBeInstanceOf(PgWebhookDeliveryStore);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Postgres-backed implementation'),
      undefined,
      expect.objectContaining({ backend: 'postgres', durable: true, store: 'PgWebhookDeliveryStore' })
    );

    // Startup hydration is kicked off (and not awaited) against the pool.
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalled());
  });

  it('warns when the in-memory store is active in production', () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const store = createWebhookDeliveryStore({ backend: 'memory', nodeEnv: 'production' });

    expect(store).toBeInstanceOf(WebhookDeliveryStore);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('IN-MEMORY'),
      undefined,
      expect.objectContaining({ backend: 'memory', nodeEnv: 'production' })
    );
  });

  it('falls back to the in-memory store when Postgres cannot initialise', () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const store = createWebhookDeliveryStore({
      backend: 'postgres',
      pool: {},
      createPostgresStore: () => {
        throw new Error('pool unavailable');
      },
    });

    expect(store).toBeInstanceOf(WebhookDeliveryStore);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('falling back to memory'),
      undefined,
      expect.objectContaining({ error: 'pool unavailable' })
    );
  });

  it('factory-selected stores produce identical observable results', () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});

    const pool = makePool();
    const inMemory = createWebhookDeliveryStore({ backend: 'memory' });
    const postgres = createWebhookDeliveryStore({
      backend: 'postgres',
      pool,
      createPostgresStore: (p) => new PgWebhookDeliveryStore(p as import('pg').Pool),
    });

    expect(observe(postgres)).toEqual(observe(inMemory));
  });
});
