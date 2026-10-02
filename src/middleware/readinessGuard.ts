/**
 * Readiness guard middleware.
 *
 * Rejects all incoming requests with 503 Service Unavailable until the service
 * completes startup and reaches the READY phase. This prevents clients from
 * hitting incomplete dependency initialization, connection pool exhaustion,
 * or other transient startup failures.
 *
 * ## Behavior
 *
 * - During startup (INITIALIZING through INDEXER_READY phases): returns 503.
 * - During READY phase: passes request through to subsequent handlers.
 * - During SHUTTING_DOWN: returns 503 (rejects new work during graceful shutdown).
 *
 * ## Response Format
 *
 * 503 responses include:
 *   - `status` — always "unavailable"
 *   - `phase` — current startup phase (for diagnostics)
 *   - `timestamp` — ISO 8601 timestamp
 *   - `message` — human-readable explanation
 *
 * The flat structure mirrors the /health endpoint so load balancers and
 * monitoring tools can parse responses consistently.
 *
 * ## Placement
 *
 * Must be mounted at the application root (before all route handlers) so it
 * intercepts every incoming request early:
 *
 *   ```typescript
 *   app.use(readinessGuardMiddleware());
 *   app.use(otherMiddleware);
 *   app.use(routes);
 *   ```
 */

import type { Request, Response, NextFunction } from 'express';
import { isReady, getPhase } from '../startup/readiness.js';

/**
 * Create a readiness guard middleware that rejects requests during startup.
 *
 * @returns Express middleware function
 */
export function readinessGuardMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isReady()) {
      // Service is ready; allow the request to proceed.
      next();
      return;
    }

    // Service is not ready; reject with 503.
    const phase = getPhase();
    const message =
      phase === 'SHUTTING_DOWN'
        ? 'Service is shutting down'
        : `Service is starting up (phase: ${phase})`;

    res.status(503).json({
      status: 'unavailable',
      phase,
      timestamp: new Date().toISOString(),
      message,
    });
  };
}
