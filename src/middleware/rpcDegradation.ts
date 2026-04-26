/**
 * RPC degradation middleware.
 *
 * When the Stellar RPC circuit breaker is OPEN the backend enters a degraded
 * operating mode with two observable client outcomes:
 *
 *  1. **Read requests** (GET, HEAD, OPTIONS) are allowed through so cached /
 *     database-backed data can still be served.  A `Warning` response header
 *     signals that the data may be stale.
 *
 *  2. **Mutating requests** (POST, PUT, PATCH, DELETE) are rejected with
 *     `503 Service Unavailable` because the backend cannot guarantee
 *     chain-consistency for writes while the RPC provider is unreachable.
 *
 * Every response carries an `X-Degradation-State` header reflecting the
 * current circuit state so clients and monitoring agents can observe
 * degradation without polling the health endpoint.
 *
 * Usage: mount before route handlers that serve chain-derived data.
 */

import type { Request, Response, NextFunction } from 'express';
import type { StellarRpcService } from '../services/stellar-rpc.js';
import { logger } from '../lib/logger.js';

export const STALE_WARNING = '199 fluxora-backend "Stellar RPC unavailable - data may be stale"';

export const DEGRADED_WRITE_MESSAGE =
  'Stellar RPC is currently unavailable — mutating operations are temporarily suspended';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Returns Express middleware that enforces degradation policy based on the
 * circuit breaker state of the given {@link StellarRpcService}.
 *
 * @param getService - factory / accessor returning the active service instance
 */
export function createRpcDegradationMiddleware(getService: () => StellarRpcService) {
  let lastLoggedState: string | undefined;

  return function rpcDegradationMiddleware(req: Request, res: Response, next: NextFunction): void {
    const svc = getService();
    const snapshot = svc.getDegradationSnapshot();
    const { circuitState, degraded } = snapshot;

    res.setHeader('X-Degradation-State', circuitState);

    if (circuitState !== lastLoggedState) {
      logger.warn('RPC degradation state changed', undefined, {
        event: 'rpc_degradation_transition',
        previousState: lastLoggedState ?? 'INIT',
        currentState: circuitState,
        failureCount: snapshot.failureCount,
      });
      lastLoggedState = circuitState;
    }

    if (!degraded) {
      return next();
    }

    // Degraded path: reads are allowed with a staleness warning.
    if (READ_METHODS.has(req.method)) {
      res.setHeader('Warning', STALE_WARNING);
      return next();
    }

    // Writes are blocked while the circuit is tripped.
    logger.warn('Write request rejected due to RPC degradation', undefined, {
      event: 'rpc_degradation_write_blocked',
      method: req.method,
      path: req.originalUrl,
      circuitState,
    });

    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: DEGRADED_WRITE_MESSAGE,
        degradation: {
          circuitState,
          failureCount: snapshot.failureCount,
          openedAt: snapshot.openedAt,
        },
      },
    });
  };
}
