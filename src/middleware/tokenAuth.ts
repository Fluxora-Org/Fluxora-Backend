import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { serviceUnavailable, unauthorizedError } from '../errors.js';

export interface TokenAuthOptions {
  role: 'partner' | 'administrator';
  token?: string;
  required: boolean;
}

function getBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;

  const [scheme, value] = headerValue.split(' ', 2);
  if (scheme !== 'Bearer' || !value) {
    return null;
  }

  return value.trim();
}

export function createBearerTokenAuth(options: TokenAuthOptions): RequestHandler {
  const authEnabled = options.required || Boolean(options.token);

  return (req: Request, _res: Response, next: NextFunction) => {
    if (!authEnabled) {
      next();
      return;
    }

    if (!options.token) {
      next(
        serviceUnavailable(`${options.role} authentication is required but not configured`, {
          role: options.role,
        }),
      );
      return;
    }

    const bearerToken = getBearerToken(req.header('authorization'));
    if (!bearerToken) {
      next(
        unauthorizedError(`${options.role} bearer token is required`, {
          role: options.role,
        }),
      );
      return;
    }

    if (bearerToken !== options.token) {
      next(
        unauthorizedError(`Invalid ${options.role} bearer token`, {
          role: options.role,
        }),
      );
      return;
    }

    next();
  };
}
