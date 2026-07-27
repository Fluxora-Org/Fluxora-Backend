import type { Request, Response, NextFunction } from 'express';
import type { AuthAttemptStore } from '../redis/authAttemptStore.js';
import { getClientIp } from '../ws/connectionLimiter.js';

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

  if (ip && ip !== 'unknown') {
    const ipLockout = await authAttemptStore.isLockedOut(ip);
    if (ipLockout > 0) {
      res.setHeader('Retry-After', String(ipLockout));
      res.status(429).json({
        success: false,
        message: 'Too many failed attempts, try again later',
      });
      return;
    }
  }

  if (address) {
    const addrLockout = await authAttemptStore.isLockedOut(address);
    if (addrLockout > 0) {
      res.setHeader('Retry-After', String(addrLockout));
      res.status(429).json({
        success: false,
        message: 'Too many failed attempts, try again later',
      });
      return;
    }
  }

  req.authAttemptStore = authAttemptStore;
  next();
}
