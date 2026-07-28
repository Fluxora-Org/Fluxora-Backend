/**
 * Canary Routing Middleware
 *
 * Performs a stable, deterministic per-request canary traffic split using a
 * SHA-256 hash of the client identity (API key when present, falling back to
 * client IP). A configurable percentage of requests are tagged as canary by
 * setting `req.isCanary = true` and echoing an `X-Fluxora-Canary: true`
 * response header so operators can correlate canary traffic in logs and
 * metrics.
 *
 * Design goals
 * ─────────────
 * 1. Determinism — the same client always lands in the same bucket for the
 *    lifetime of a deployment. Routing is a pure function of
 *    (clientIdentity, CANARY_SALT, CANARY_TRAFFIC_PERCENT).
 *
 * 2. Independence — uses its own CANARY_SALT so canary bucketing is
 *    completely uncorrelated from any feature-flag rollout hashes that may
 *    share the same client-identity inputs. Correlated hashes would silently
 *    confound A/B measurements.
 *
 * 3. Graceful degradation — when the client identity cannot be determined
 *    (no IP, no API-key) the middleware skips tagging and calls next()
 *    without raising an error.
 *
 * 4. Correlation-ID integration — the canary decision is logged at debug
 *    level with the request's correlation ID so canary requests are
 *    traceable end-to-end through the structured log pipeline.
 *
 * 5. Security — the raw client IP is never reflected in logs. The API key
 *    is never reflected in logs. The salt is held in CANARY_SALT env var
 *    and never logged.
 *
 * Configuration
 * ─────────────
 * CANARY_TRAFFIC_PERCENT  integer 0–100, default 0 (all traffic stable)
 * CANARY_SALT             arbitrary string, default 'canary-routing-v1'
 *
 * Algorithm
 * ─────────
 * 1. Identify the client: prefer the `X-API-Key` request header; fall back
 *    to `req.ip` (Express-resolved, trusts proxy when app trust-proxy is set).
 * 2. Compute: SHA-256(CANARY_SALT + ':' + clientIdentity)
 * 3. Take the first 8 hex characters of the digest → parse as uint32.
 * 4. Map to [0, 100) via: bucket = uint32 % 100
 * 5. Tag as canary when: bucket < CANARY_TRAFFIC_PERCENT
 *
 * This gives a uniform distribution over 100 buckets. Operators who need
 * finer granularity (e.g. 0.5%) should scale CANARY_TRAFFIC_PERCENT to an
 * integer in [0, 10000] and update the modulus — the exported helper
 * `computeCanaryBucket` accepts a custom modulus for that.
 */

import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Response header echoed to the caller so that proxies, dashboards, and
 * integration tests can observe the canary decision without inspecting logs.
 */
export const CANARY_HEADER = 'X-Fluxora-Canary';

/**
 * Default salt used when CANARY_SALT is not set.
 *
 * The salt is intentionally namespaced differently from any feature-flag salt
 * to guarantee that the canary and feature-flag hash spaces are independent
 * even when the underlying client identity string is the same.
 */
export const DEFAULT_CANARY_SALT = 'canary-routing-v1';

/**
 * Total number of buckets used for the modulo operation.
 * 100 maps directly to "percent", making CANARY_TRAFFIC_PERCENT intuitive.
 */
export const CANARY_BUCKET_COUNT = 100;

// ---------------------------------------------------------------------------
// Core helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Derive a stable bucket number [0, modulus) for a given (salt, identity)
 * pair using the first 8 hex characters of SHA-256 as a uint32.
 *
 * @param salt     - Domain-specific salt (prevents cross-experiment correlation)
 * @param identity - Client identity (API key or IP address)
 * @param modulus  - Number of buckets; defaults to CANARY_BUCKET_COUNT (100)
 * @returns        - Integer in [0, modulus)
 */
export function computeCanaryBucket(
  salt: string,
  identity: string,
  modulus: number = CANARY_BUCKET_COUNT,
): number {
  const digest = createHash('sha256')
    .update(`${salt}:${identity}`)
    .digest('hex');

  // Use the first 8 hex characters (32 bits) to avoid BigInt overhead while
  // still giving a uniform distribution over 2^32 values.
  const uint32 = parseInt(digest.slice(0, 8), 16);
  return uint32 % modulus;
}

/**
 * Resolve the stable client identity for canary bucketing.
 *
 * Preference order:
 *   1. `X-API-Key` request header (authenticated callers always map to the
 *      same bucket regardless of IP — important for proxy/CDN deployments).
 *   2. `req.ip` — Express-resolved client IP (respects `trust proxy`).
 *
 * Returns `undefined` when no identity can be determined (e.g. tests that
 * do not set an IP and send no API key).
 */
export function resolveClientIdentity(req: Request): string | undefined {
  // Prefer API key: provides a stable identity across NAT/proxy topologies.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  // Fall back to client IP.
  if (req.ip && req.ip.length > 0) {
    return req.ip;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Middleware factory (accepts explicit config for testability)
// ---------------------------------------------------------------------------

/**
 * Options accepted by `createCanaryRoutingMiddleware`.
 *
 * All fields are optional; production callers should rely on environment
 * variables. Tests may pass explicit values to avoid polluting process.env.
 */
export interface CanaryRoutingOptions {
  /**
   * Percentage of requests to tag as canary [0, 100].
   * Reads CANARY_TRAFFIC_PERCENT from the environment when omitted.
   * Defaults to 0 (no canary traffic).
   */
  trafficPercent?: number;

  /**
   * Salt used to isolate this hash from other rollout hashes.
   * Reads CANARY_SALT from the environment when omitted.
   * Defaults to DEFAULT_CANARY_SALT.
   */
  salt?: string;
}

/**
 * Returns an Express middleware that performs a stable canary traffic split.
 *
 * Mount this **after** `correlationIdMiddleware` so that `req.correlationId`
 * is available for structured logging of the canary decision.
 *
 * @example
 * ```typescript
 * app.use(correlationIdMiddleware);
 * app.use(createCanaryRoutingMiddleware());
 * ```
 */
export function createCanaryRoutingMiddleware(options: CanaryRoutingOptions = {}) {
  return function canaryRoutingMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // ── Resolve configuration ─────────────────────────────────────────────

    const trafficPercent =
      options.trafficPercent ??
      (() => {
        const raw = process.env['CANARY_TRAFFIC_PERCENT'];
        if (raw === undefined || raw === '') return 0;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
      })();

    const salt =
      options.salt ?? (process.env['CANARY_SALT'] ?? DEFAULT_CANARY_SALT);

    // ── Fast path: canary disabled ────────────────────────────────────────

    if (trafficPercent === 0) {
      req.isCanary = false;
      next();
      return;
    }

    // ── Resolve client identity ───────────────────────────────────────────

    const identity = resolveClientIdentity(req);

    if (identity === undefined) {
      // Cannot determine client identity; skip tagging to avoid false
      // positives. Log at debug level so test harnesses can diagnose
      // unexpected misses without polluting production logs.
      logger.debug(
        'Canary routing: unable to determine client identity; request not tagged',
        req.correlationId,
        { component: 'canary-routing' },
      );
      req.isCanary = false;
      next();
      return;
    }

    // ── Compute bucket and apply decision ─────────────────────────────────

    const bucket = computeCanaryBucket(salt, identity);
    const isCanary = bucket < trafficPercent;

    req.isCanary = isCanary;

    if (isCanary) {
      res.setHeader(CANARY_HEADER, 'true');

      logger.debug(
        'Canary routing: request tagged as canary',
        req.correlationId,
        {
          component: 'canary-routing',
          bucket,
          trafficPercent,
        },
      );
    }

    next();
  };
}

/**
 * Default export: a pre-built middleware instance that reads configuration
 * from environment variables at request time. Suitable for use in
 * `app.use(canaryRoutingMiddleware)`.
 */
export const canaryRoutingMiddleware = createCanaryRoutingMiddleware();
