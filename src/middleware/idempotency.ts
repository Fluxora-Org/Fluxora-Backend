/**
 * Idempotency middleware for Fluxora Backend.
 *
 * Clients may supply an `Idempotency-Key` header on mutating requests (POST).
 * If the same key is seen within the TTL window, the cached response is
 * replayed instead of re-executing the handler — preventing duplicate stream
 * creation on network retries.
 *
 * Trust boundaries
 * ----------------
 * - Idempotency keys are scoped per HTTP method + path + key value.
 * - Keys are accepted from any client; they are not authenticated.
 * - Keys must be 8–128 printable ASCII characters.
 *
 * Failure modes
 * -------------
 * - Cache unavailable → request proceeds normally (fail-open).
 * - Invalid key format → 400 Bad Request.
 * - Duplicate key     → 200 with cached response body + `Idempotent-Replayed: true` header.
 *
 * @module middleware/idempotency
 */

import type { Request, Response, NextFunction } from 'express';
import { getCacheClient } from '../cache/redis.js';
import { logger } from '../lib/logger.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours
const KEY_PATTERN = /^[\x20-\x7E]{8,128}$/;

interface CachedResponse {
  status: number;
  body: unknown;
}

function buildIdempotencyKey(method: string, path: string, key: string): string {
  return `fluxora:idempotency:${method}:${path}:${key}`;
}

/**
 * Idempotency middleware — attach to POST routes that create resources.
 *
 * If no `Idempotency-Key` header is present the request proceeds normally.
 */
export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawKey = req.headers[IDEMPOTENCY_HEADER];

  // No key supplied — pass through
  if (rawKey === undefined) {
    next();
    return;
  }

  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (key === undefined || !KEY_PATTERN.test(key)) {
    res.status(400).json({
      error: {
        code: 'invalid_idempotency_key',
        message:
          'Idempotency-Key must be 8–128 printable ASCII characters.',
        status: 400,
      },
    });
    return;
  }

  const cacheKey = buildIdempotencyKey(req.method, req.path, key);
  const cache = getCacheClient();

  // Async check — we need to intercept the response to cache it
  void (async () => {
    try {
      const cached = await cache.get<CachedResponse>(cacheKey);

      if (cached !== null) {
        logger.info('Idempotent replay', req.correlationId, {
          idempotencyKey: key,
          cachedStatus: cached.status,
        });
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(cached.status).json(cached.body);
        return;
      }
    } catch (err) {
      // Fail-open
      logger.warn('Idempotency cache read error — proceeding', req.correlationId, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Intercept res.json to cache the response
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void cache
          .set(cacheKey, { status: res.statusCode, body }, IDEMPOTENCY_TTL_SECONDS)
          .catch((err: unknown) => {
            logger.warn('Idempotency cache write error', req.correlationId, {
              /* istanbul ignore next */
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      return originalJson(body);
    };

    next();
  })();
}
