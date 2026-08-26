import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { mtlsValidationMiddleware, setMtlsRequired, _resetMtlsRequiredForTest } from '../../src/indexer/mtls.js';
import { TLSSocket } from 'tls';

/**
 * Create a minimal no-TLS mock socket that is NOT a TLSSocket.
 */
function createNonTlsMockSocket() {
  return {};
}

/**
 * Create a mock TLSSocket-like object with given authorized state.
 */
function createMockTlsSocket(overrides: {
  authorized?: boolean;
  authorizationError?: Error | null;
  peerCertificate?: object;
} = {}) {
  const socket = Object.create(TLSSocket.prototype);
  Object.assign(socket, {
    authorized: overrides.authorized ?? true,
    authorizationError: overrides.authorizationError ?? null,
    getPeerCertificate: () => overrides.peerCertificate ?? null,
  });
  return socket;
}

function createMockReq(socketOrOverrides: object = {}): Partial<Request> {
  const socket = socketOrOverrides;
  return { socket, ip: '127.0.0.1', id: 'test-req-id', correlationId: 'test-correlation-id' } as any;
}

function createMockRes(): Partial<Response> & { _statusCode: number; _body: any } {
  const res: any = {
    _statusCode: 200,
    _body: undefined,
    status(code: number) {
      this._statusCode = code;
      return this;
    },
    json(body: any) {
      this._body = body;
      return this;
    },
  };
  return res;
}

describe('mtlsValidationMiddleware', () => {
  beforeEach(() => {
    _resetMtlsRequiredForTest();
  });

  afterEach(() => {
    _resetMtlsRequiredForTest();
  });

  describe('when INDEXER_MTLS_REQUIRED is false (permissive — default)', () => {
    it('bypasses mTLS checks for non-TLS connections', () => {
      let nextCalled = false;
      const req = createMockReq(createNonTlsMockSocket());
      const res = createMockRes();
      const next = () => { nextCalled = true; };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(nextCalled).toBe(true);
      expect(res._statusCode).toBe(200);
    });

    it('bypasses when TLS socket is authorized', () => {
      let nextCalled = false;
      const req = createMockReq(createMockTlsSocket({ authorized: true }));
      const res = createMockRes();
      const next = () => { nextCalled = true; };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(nextCalled).toBe(true);
      expect(res._statusCode).toBe(200);
    });

    it('rejects when TLS socket is not authorized (missing cert)', () => {
      const req = createMockReq(createMockTlsSocket({
        authorized: false,
        peerCertificate: {},
      }));
      const res = createMockRes();
      const next = () => { throw new Error('next() should not be called'); };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(res._statusCode).toBe(401);
      expect(res._body?.error?.code).toBe('UNAUTHORIZED');
    });

    it('rejects when TLS socket authorization fails (expired cert)', () => {
      const req = createMockReq(createMockTlsSocket({
        authorized: false,
        authorizationError: new Error('certificate has expired'),
        peerCertificate: { subject: {}, issuer: {}, serialNumber: 'abc' },
      }));
      const res = createMockRes();
      const next = () => { throw new Error('next() should not be called'); };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(res._statusCode).toBe(403);
      expect(res._body?.error?.code).toBe('FORBIDDEN');
    });
  });

  describe('when INDEXER_MTLS_REQUIRED is true (strict / fail-closed)', () => {
    beforeEach(() => {
      setMtlsRequired(true);
    });

    it('rejects non-TLS connections with 403', () => {
      const req = createMockReq(createNonTlsMockSocket());
      const res = createMockRes();
      const next = () => { throw new Error('next() should not be called'); };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(res._statusCode).toBe(403);
      expect(res._body?.error?.code).toBe('FORBIDDEN');
      expect(res._body?.error?.message).toBe('mTLS is required but connection is not TLS');
    });

    it('bypasses when TLS socket is authorized', () => {
      let nextCalled = false;
      const req = createMockReq(createMockTlsSocket({ authorized: true }));
      const res = createMockRes();
      const next = () => { nextCalled = true; };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(nextCalled).toBe(true);
      expect(res._statusCode).toBe(200);
    });

    it('rejects when TLS socket is not authorized', () => {
      const req = createMockReq(createMockTlsSocket({
        authorized: false,
        peerCertificate: { subject: {}, issuer: {}, serialNumber: 'xyz' },
      }));
      const res = createMockRes();
      const next = () => { throw new Error('next() should not be called'); };

      mtlsValidationMiddleware(req as Request, res as Response, next);

      expect(res._statusCode).toBe(403);
    });
  });
});
