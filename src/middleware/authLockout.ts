import type { Request, Response, NextFunction } from 'express';
import type { AuthAttemptStore } from '../redis/authAttemptStore.js';
import { getClientIp } from '../ws/connectionLimiter.js';
import { ApiErrorCode } from '../errors.js';
import { errorResponse } from '../utils/response.js';

let authAttemptStore: AuthAttemptStore | null = null;

export function setAuthAttemptStore(store: AuthAttemptStore): void {
  authAttemptStore = store;
}

export async function authLockoutMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!authAttemptStore) {
    return next();
  }

  const ip = getClientIp(req);
  const address = req.body?.address as string | undefined;

  try {
    if (ip && ip !== 'unknown') {
      const ipLockout = await authAttemptStore.isLockedOut(ip);
      if (ipLockout > 0) {
        res.setHeader('Retry-After', String(ipLockout));
        res.status(429).json(errorResponse(ApiErrorCode.TOO_MANY_REQUESTS, 'Too many failed attempts, try again later', undefined, req.correlationId));
        return;
      }
    }

    if (address) {
      const addrLockout = await authAttemptStore.isLockedOut(address);
      if (addrLockout > 0) {
        res.setHeader('Retry-After', String(addrLockout));
        res.status(429).json(errorResponse(ApiErrorCode.TOO_MANY_REQUESTS, 'Too many failed attempts, try again later', undefined, req.correlationId));
        return;
      }
    }
  } catch (err) {
    // Forward store errors to the Express error handler so they produce a
    // deterministic 500 response rather than an unhandled rejection.
    return next(err);
  }

  req.authAttemptStore = authAttemptStore;
  next();
}
