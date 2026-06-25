import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';

import { serviceUnavailable, unauthorizedError } from '../errors.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { wsAuthFailureTotal } from '../metrics/businessMetrics.js';

// ── WebSocket JWT auth ────────────────────────────────────────────────────────

export interface WsTokenPayload {
  sub: string;
  role?: string;
}

export type WsAuthFailureCode = 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'AUTH_NOT_CONFIGURED';

export type WsTokenResult =
  | { ok: true; payload: WsTokenPayload }
  | { ok: false; code: WsAuthFailureCode };

/** Failure codes that warrant an audit entry (repeat-worthy signals). */
const AUDIT_WORTHY: ReadonlySet<WsAuthFailureCode> = new Set([
  'INVALID_TOKEN',
  'AUTH_NOT_CONFIGURED',
]);

/**
 * Extract and verify a JWT for a WebSocket upgrade request.
 *
 * Token lookup order (first match wins):
 *   1. `Authorization: Bearer <token>` header
 *   2. `?token=<token>` query-string parameter
 *
 * Failures emit a structured warning log, increment the
 * `fluxora_ws_auth_failure_total` counter, and—for notable codes—write an
 * audit entry. No token material is ever included in logs, metrics, or audit.
 *
 * Returns a discriminated union so callers can decide whether to close the
 * socket or allow the connection through (backward-compatible rollout).
 */
export function verifyWsToken(req: IncomingMessage, secret: string | undefined): WsTokenResult {
  if (!secret) {
    const code: WsAuthFailureCode = 'AUTH_NOT_CONFIGURED';
    _recordWsAuthFailure(code, req);
    return { ok: false, code };
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
    const code: WsAuthFailureCode = 'MISSING_TOKEN';
    _recordWsAuthFailure(code, req);
    return { ok: false, code };
  }

  try {
    const payload = jwt.verify(token, secret) as WsTokenPayload;
    return { ok: true, payload };
  } catch {
    const code: WsAuthFailureCode = 'INVALID_TOKEN';
    _recordWsAuthFailure(code, req);
    return { ok: false, code };
  }
}

/**
 * Emit observability signals for a WS auth failure.
 * Never includes the raw token value.
 * @internal
 */
function _recordWsAuthFailure(code: WsAuthFailureCode, req: IncomingMessage): void {
  // 1. Structured warning log (no token material).
  logger.warn('ws_auth_failure', undefined, {
    event: 'ws_auth_failure',
    reason: code,
    remoteAddress: req.socket?.remoteAddress,
    url: req.url,
  });

  // 2. Prometheus counter — fixed label set prevents cardinality blowup.
  wsAuthFailureTotal.inc({ reason: code });

  // 3. Audit entry for notable / operator-actionable failure codes.
  if (AUDIT_WORTHY.has(code)) {
    recordAuditEvent('WS_AUTH_FAILURE', 'ws_connection', req.socket?.remoteAddress ?? 'unknown', undefined, { reason: code });
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
