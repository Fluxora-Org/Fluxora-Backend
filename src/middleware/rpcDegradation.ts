/**
 * RPC degradation middleware.
 *
 * When the Stellar RPC circuit is OPEN, read responses are allowed to proceed
 * (served from Postgres cache) but carry a Warning header so clients know the
 * data may be stale.
 *
 * Usage: mount before route handlers that serve chain-derived data.
 */

import type { Request, Response, NextFunction } from 'express';
import type { StellarRpcService } from '../services/stellar-rpc.js';

export const STALE_WARNING = '199 fluxora-backend "Stellar RPC unavailable - data may be stale"';

/**
 * Returns middleware that checks the circuit state of the given service.
 * Accepts the service as a parameter so it can be injected in tests.
 */
export function createRpcDegradationMiddleware(getService: () => StellarRpcService) {
  return function rpcDegradationMiddleware(_req: Request, res: Response, next: NextFunction): void {
    if (getService().getCircuitState() === 'OPEN') {
      res.setHeader('Warning', STALE_WARNING);
    }
    next();
  };
}
