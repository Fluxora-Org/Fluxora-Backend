/**
 * @module webhooks/storeFactory
 *
 * Selects and exports the active `IWebhookDeliveryStore` singleton based on
 * the `WEBHOOK_DELIVERY_STORE` environment variable.
 *
 * | WEBHOOK_DELIVERY_STORE | Implementation         | Durable? |
 * |------------------------|------------------------|----------|
 * | `"memory"` (default)   | `WebhookDeliveryStore` | ❌        |
 * | `"postgres"`           | `PgWebhookDeliveryStore`| ✅       |
 *
 * A startup warning is emitted when `NODE_ENV=production` and the in-memory
 * store is active (missing flag or explicitly set to `"memory"`).
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
type StoreBackend = 'memory' | 'postgres';

function resolveBackend(): StoreBackend {
  const raw = (process.env.WEBHOOK_DELIVERY_STORE ?? '').toLowerCase().trim();
  if (raw === 'postgres') return 'postgres';
  return 'memory';
}

function createStore(): IWebhookDeliveryStore {
  const backend = resolveBackend();
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  if (backend === 'postgres') {
    // Lazy-import to avoid pulling in pg in environments that don't need it.
    // The import is synchronous (static require) so the singleton is ready
    // immediately — the Postgres pool is already initialised by the time any
    // module imports this factory.
    try {
      const { PgWebhookDeliveryStore } = require('./pgStore.js') as typeof import('./pgStore.js');
      const { getPool } = require('../db/pool.js') as typeof import('../db/pool.js');
      const pool = getPool();
      const store = new PgWebhookDeliveryStore(pool);

      // Fire-and-forget hydration; errors are logged inside hydrate().
      store.hydrate().catch((err: unknown) => {
        logger.error('Webhook delivery store failed to hydrate on startup', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      logger.info('Webhook delivery store: using Postgres-backed implementation', undefined, {
        backend: 'postgres',
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
    durable: false,
  });

  return new WebhookDeliveryStore();
}

/**
 * The active webhook delivery store singleton.
 *
 * Callers import this instead of constructing their own instance.
 * The backing implementation is determined by `WEBHOOK_DELIVERY_STORE`.
 */
export const webhookDeliveryStore: IWebhookDeliveryStore = createStore();
