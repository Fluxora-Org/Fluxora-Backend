/**
 * Token auth middleware unit tests
 *
 * Covers edge cases for:
 * - verifyWsToken (WebSocket JWT auth)
 * - createBearerTokenAuth (partner/admin bearer token auth)
 * - Observability (logging, metrics, audit)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IncomingMessage } from 'http';
import {
  verifyWsToken,
  WsAuthFailureCode,
  createBearerTokenAuth,
  TokenAuthOptions,
} from '../../src/middleware/tokenAuth.js';
import jwt from 'jsonwebtoken';

// Mock dependencies
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock('../../src/metrics/businessMetrics.js', () => ({
  wsAuthFailureTotal: {
    inc: vi.fn(),
  },
}));

describe('verifyWsToken', () => {
  let logger: any, recordAuditEvent: any, wsAuthFailureTotal: any;
  const SECRET = 'test-secret-key';

  beforeEach(async () => {
    vi.clearAllMocks();
    const loggerModule = await import('../../src/lib/logger.js');
    logger = loggerModule.logger;
    const auditModule = await import('../../src/lib/auditLog.js');
    recordAuditEvent = auditModule.recordAuditEvent;
    const metricsModule = await import('../../src/metrics/businessMetrics.js');
    wsAuthFailureTotal = metricsModule.wsAuthFailureTotal;
  });

  it('returns AUTH_NOT_CONFIGURED when secret is undefined', () => {
    const req = {} as IncomingMessage;
    const result = verifyWsToken(req, undefined);

    expect(result).toEqual({ ok: false, code: 'AUTH_NOT_CONFIGURED' as WsAuthFailureCode });
    expect(logger.warn).toHaveBeenCalledWith(
      'ws_auth_failure',
      undefined,
      expect.objectContaining({ reason: 'AUTH_NOT_CONFIGURED' }),
    );
    expect(wsAuthFailureTotal.inc).toHaveBeenCalledWith({ reason: 'AUTH_NOT_CONFIGURED' });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'WS_AUTH_FAILURE',
      'ws_connection',
      'unknown',
      undefined,
      { reason: 'AUTH_NOT_CONFIGURED' },
    );
  });

  it('returns MISSING_TOKEN when Authorization header is absent', () => {
    const req = { headers: {}, url: '/ws' } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: false, code: 'MISSING_TOKEN' as WsAuthFailureCode });
    expect(logger.warn).toHaveBeenCalledWith(
      'ws_auth_failure',
      undefined,
      expect.objectContaining({ reason: 'MISSING_TOKEN' }),
    );
    expect(wsAuthFailureTotal.inc).toHaveBeenCalledWith({ reason: 'MISSING_TOKEN' });
    expect(recordAuditEvent).not.toHaveBeenCalled(); // MISSING_TOKEN is not audit-worthy
  });

  it('returns MISSING_TOKEN when Authorization header is not Bearer scheme', () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' }, url: '/ws' } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: false, code: 'MISSING_TOKEN' as WsAuthFailureCode });
    expect(logger.warn).toHaveBeenCalledWith(
      'ws_auth_failure',
      undefined,
      expect.objectContaining({ reason: 'MISSING_TOKEN' }),
    );
  });

  it('returns MISSING_TOKEN when Bearer token is empty', () => {
    const req = { headers: { authorization: 'Bearer ' }, url: '/ws' } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: false, code: 'MISSING_TOKEN' as WsAuthFailureCode });
  });

  it('returns MISSING_TOKEN when Bearer token is whitespace-only', () => {
    const req = { headers: { authorization: 'Bearer   ' }, url: '/ws' } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: false, code: 'MISSING_TOKEN' as WsAuthFailureCode });
  });

  it('extracts token from Authorization header when present', () => {
    const validToken = jwt.sign({ sub: 'user123', role: 'operator' }, SECRET);
    const req = { headers: { authorization: `Bearer ${validToken}` }, url: '/ws' } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: true, payload: { sub: 'user123', role: 'operator' } });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(wsAuthFailureTotal.inc).not.toHaveBeenCalled();
  });

  it('extracts token from query string when Authorization header is absent', () => {
    const validToken = jwt.sign({ sub: 'user123', role: 'operator' }, SECRET);
    const req = { headers: {}, url: '/ws?token=' + validToken } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: true, payload: { sub: 'user123', role: 'operator' } });
  });

  it('prefers Authorization header over query string', () => {
    const headerToken = jwt.sign({ sub: 'header-user', role: 'admin' }, SECRET);
    const queryToken = jwt.sign({ sub: 'query-user', role: 'operator' }, SECRET);
    const req = {
      headers: { authorization: `Bearer ${headerToken}` },
      url: '/ws?token=' + queryToken,
    } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: true, payload: { sub: 'header-user', role: 'admin' } });
  });

  it('returns INVALID_TOKEN when JWT verification fails', () => {
    const req = { headers: { authorization: 'Bearer invalid-token' }, url: '/ws' } as IncomingMessage;
    const result = verifyWsToken(req, SECRET);

    expect(result).toEqual({ ok: false, code: 'INVALID_TOKEN' as WsAuthFailureCode });
    expect(logger.warn).toHaveBeenCalledWith(
      'ws_auth_failure',
      undefined,
      expect.objectContaining({ reason: 'INVALID_TOKEN' }),
    );
    expect(wsAuthFailureTotal.inc).toHaveBeenCalledWith({ reason: 'INVALID_TOKEN' });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'WS_AUTH_FAILURE',
      'ws_connection',
      'unknown',
      undefined,
      { reason: 'INVALID_TOKEN' },
    );
  });

  it('includes remoteAddress in logs when available', () => {
    const req = {
      headers: { authorization: 'Bearer invalid' },
      url: '/ws',
      socket: { remoteAddress: '192.168.1.1' },
    } as IncomingMessage;
    verifyWsToken(req, SECRET);

    expect(logger.warn).toHaveBeenCalledWith(
      'ws_auth_failure',
      undefined,
      expect.objectContaining({ remoteAddress: '192.168.1.1' }),
    );
  });

  it('handles missing remoteAddress gracefully in logs', () => {
    const req = {
      headers: { authorization: 'Bearer invalid' },
      url: '/ws',
      socket: {},
    } as IncomingMessage;
    verifyWsToken(req, SECRET);

    expect(logger.warn).toHaveBeenCalledWith(
      'ws_auth_failure',
      undefined,
      expect.objectContaining({ remoteAddress: undefined }),
    );
  });

  it('handles missing socket gracefully in logs', () => {
    const req = {
      headers: { authorization: 'Bearer invalid' },
      url: '/ws',
    } as IncomingMessage;
    verifyWsToken(req, SECRET);

    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createBearerTokenAuth', () => {
  it('bypasses auth when required is false and token is not configured', () => {
    const options: TokenAuthOptions = { role: 'partner', required: false };
    const middleware = createBearerTokenAuth(options);

    const req = {} as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('bypasses auth when required is true but token is configured and matches', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true, token: 'secret-token' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue('Bearer secret-token') } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 503 when auth is required but token is not configured', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true };
    const middleware = createBearerTokenAuth(options);

    const req = {} as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'partner authentication is required but not configured',
        details: { role: 'partner' },
      }),
    );
  });

  it('returns 401 when Authorization header is missing', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true, token: 'secret-token' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue(undefined) } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'partner bearer token is required',
        details: { role: 'partner' },
      }),
    );
  });

  it('returns 401 when Authorization header is not Bearer scheme', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true, token: 'secret-token' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue('Basic dXNlcjpwYXNz') } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'partner bearer token is required',
        details: { role: 'partner' },
      }),
    );
  });

  it('returns 401 when Bearer token is empty', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true, token: 'secret-token' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue('Bearer ') } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'partner bearer token is required',
        details: { role: 'partner' },
      }),
    );
  });

  it('returns 401 when Bearer token does not match configured token', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true, token: 'secret-token' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue('Bearer wrong-token') } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Invalid partner bearer token',
        details: { role: 'partner' },
      }),
    );
  });

  it('trims whitespace from bearer token before comparison', () => {
    const options: TokenAuthOptions = { role: 'partner', required: true, token: 'secret-token' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue('Bearer  secret-token  ') } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('handles administrator role correctly', () => {
    const options: TokenAuthOptions = { role: 'administrator', required: true, token: 'admin-secret' };
    const middleware = createBearerTokenAuth(options);

    const req = { header: vi.fn().mockReturnValue('Bearer admin-secret') } as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns service unavailable error with administrator role when token not configured', () => {
    const options: TokenAuthOptions = { role: 'administrator', required: true };
    const middleware = createBearerTokenAuth(options);

    const req = {} as any;
    const res = {} as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'administrator authentication is required but not configured',
        details: { role: 'administrator' },
      }),
    );
  });
});
