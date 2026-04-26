import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';

import { serviceUnavailable, unauthorizedError } from '../errors.js';

// ── WebSocket JWT auth ────────────────────────────────────────────────────────

export interface WsTokenPayload {
  sub: string;
  role?: string;
}

export type WsTokenResult =
  | { ok: true; payload: WsTokenPayload }
  | { ok: false; code: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'AUTH_NOT_CONFIGURED' };

/**
 * Extract and verify a JWT for a WebSocket upgrade request.
 *
 * Token lookup order (first match wins):
 *   1. `Authorization: Bearer <token>` header
 *   2. `?token=<token>` query-string parameter
 *
 * Returns a discriminated union so callers can decide whether to close the
 * socket or allow the connection through (backward-compatible rollout).
 */
export function verifyWsToken(req: IncomingMessage, secret: string | undefined): WsTokenResult {
  if (!secret) {
    return { ok: false, code: 'AUTH_NOT_CONFIGURED' };
  }

  // Extract token from header or query string.
  const authHeader = req.headers['authorization'];
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    const url = new URL(req.url ?? '/', 'ws://localhost');
    const qs = url.searchParams.get('token');
    if (qs) token = qs.trim();
  }

  if (!token) {
    return { ok: false, code: 'MISSING_TOKEN' };
  }

  try {
    const payload = jwt.verify(token, secret) as WsTokenPayload;
    return { ok: true, payload };
  } catch {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
}

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
