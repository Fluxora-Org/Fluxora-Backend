/**
 * @module webhooks/storeFactory
 *
 * Selects and exports the active `IWebhookDeliveryStore` singleton based on
 * the `WEBHOOK_DELIVERY_STORE` environment variable.
 *
 * ## Selection rule
 *
 * | `WEBHOOK_DELIVERY_STORE` value        | Implementation           | Durable? |
 * |---------------------------------------|--------------------------|----------|
 * | unset, `"memory"`, or any other value | `WebhookDeliveryStore`   | ❌        |
 * | `"postgres"`                          | `PgWebhookDeliveryStore` | ✅        |
 *
 * - Matching is case-insensitive and surrounding whitespace is trimmed.
 * - Only the exact value `postgres` selects the durable backend. Every other
 *   value — including typos such as `postgresql` or `pg` — falls back to the
 *   in-memory store, so an unrecognised value can never silently disable the
 *   durable path *or* crash the process.
 * - If the Postgres backend fails to initialise (e.g. `getPool()` throws), the
 *   error is logged and the factory falls back to the in-memory store.
 * - A startup warning is emitted when `NODE_ENV=production` and the in-memory
 *   store is active (missing flag or explicitly set to `"memory"`).
 * - The active backend is logged at startup, so operators can tell from the
 *   process logs which store is in use in each environment.
 *
 * Both implementations satisfy one shared contract test —
 * `tests/webhooks/store.contract.test.ts` — which runs the same behaviour suite
 * against each store and asserts they produce identical observable results, so
 * switching stores does not change observable behaviour.
 *
 * Usage
 * -----
 * ```ts
 * import { webhookDeliveryStore } from '../webhooks/storeFactory.js';
 * ```
 *
 * In tests that need the in-memory store explicitly:
 * ```ts
 * import { webhookDeliveryStore } from '../webhooks/store.js';
 * // (store.ts no longer re-exports the singleton; use storeFactory.ts in app code)
 * ```
 */

import type { IWebhookDeliveryStore } from './store.js';
import { WebhookDeliveryStore } from './store.js';
import { logger } from '../lib/logger.js';

/** Allowed values for WEBHOOK_DELIVERY_STORE */
export type StoreBackend = 'memory' | 'postgres';

/** Name of the environment variable that selects the active store. */
export const WEBHOOK_DELIVERY_STORE_ENV = 'WEBHOOK_DELIVERY_STORE';

/**
 * Resolve the configured backend from a raw env value.
 *
 * Exported so the selection rule can be asserted directly without booting a
 * store. Passing no argument reads `process.env.WEBHOOK_DELIVERY_STORE`.
 */
export function resolveStoreBackend(
  raw: string | undefined = process.env[WEBHOOK_DELIVERY_STORE_ENV]
): StoreBackend {
  const normalized = (raw ?? '').toLowerCase().trim();
  return normalized === 'postgres' ? 'postgres' : 'memory';
}

/**
 * Test seams for {@link createWebhookDeliveryStore}. Production callers should
 * not need to pass any options.
 */
export interface WebhookStoreFactoryOptions {
  /** Override the env-derived backend (used by tests). */
  backend?: StoreBackend;
  /** Override `NODE_ENV` when deciding whether to emit the production warning. */
  nodeEnv?: string;
  /** Pre-built pool for the Postgres backend (tests). */
  pool?: unknown;
  /** Build the durable store from a pool (tests). */
  createPostgresStore?: (pool: unknown) => IWebhookDeliveryStore;
}

/**
 * Lazy loader for the Postgres-backed store. Kept as a function (rather than a
 * static import) so environments running the in-memory backend never pull in
 * the `pg` driver.
 */
function defaultCreatePostgresStore(pool: unknown): IWebhookDeliveryStore {
  const { PgWebhookDeliveryStore } = require('./pgStore.js') as typeof import('./pgStore.js');
  return new PgWebhookDeliveryStore(pool as import('pg').Pool);
}

/** Lazy loader for the shared Postgres pool. */
function defaultGetPool(): unknown {
  const { getPool } = require('../db/pool.js') as typeof import('../db/pool.js');
  return getPool();
}

/**
 * Create the active webhook delivery store.
 *
 * The backing implementation is determined by `WEBHOOK_DELIVERY_STORE`
 * (unless `options.backend` overrides it) and the choice is logged, along with
 * the resolved `NODE_ENV`, so the active store is always visible at startup.
 */
export function createWebhookDeliveryStore(
  options: WebhookStoreFactoryOptions = {}
): IWebhookDeliveryStore {
  const backend = options.backend ?? resolveStoreBackend();
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  if (backend === 'postgres') {
    try {
      const pool = options.pool ?? defaultGetPool();
      const createPostgresStore = options.createPostgresStore ?? defaultCreatePostgresStore;
      const store = createPostgresStore(pool);

      // Fire-and-forget hydration; errors are logged inside hydrate().
      const hydratable = store as IWebhookDeliveryStore & { hydrate?: () => Promise<void> };
      if (typeof hydratable.hydrate === 'function') {
        hydratable.hydrate().catch((err: unknown) => {
          logger.error('Webhook delivery store failed to hydrate on startup', undefined, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // The active store is logged at startup so each environment's choice is
      // visible in the process logs.
      logger.info('Webhook delivery store: using Postgres-backed implementation', undefined, {
        backend: 'postgres',
        store: 'PgWebhookDeliveryStore',
        durable: true,
        nodeEnv,
      });

      return store;
    } catch (err) {
      logger.error(
        'Webhook delivery store: failed to initialise Postgres backend, falling back to memory',
        undefined,
        { error: err instanceof Error ? err.message : String(err) }
      );
      // Fall through to memory store
    }
  }

  // Emit a production warning if in-memory store is active outside dev/test
  if (isProduction) {
    logger.warn(
      '⚠️  Webhook delivery store is running IN-MEMORY in a production environment. ' +
      'Outbox items, DLQ entries, and delivery-status records will be LOST on process restart. ' +
      'Set WEBHOOK_DELIVERY_STORE=postgres to activate the durable Postgres-backed implementation.',
      undefined,
      { backend: 'memory', nodeEnv }
    );
  }

  logger.info('Webhook delivery store: using in-memory implementation', undefined, {
    backend: 'memory',
    store: 'WebhookDeliveryStore',
    durable: false,
    nodeEnv,
  });

  return new WebhookDeliveryStore();
}

/**
 * The active webhook delivery store singleton.
 *
 * Callers import this instead of constructing their own instance.
 * The backing implementation is determined by `WEBHOOK_DELIVERY_STORE`.
 */
export const webhookDeliveryStore: IWebhookDeliveryStore = createWebhookDeliveryStore();
