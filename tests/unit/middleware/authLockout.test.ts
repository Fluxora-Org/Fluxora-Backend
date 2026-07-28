/**
 * Edge-case unit tests for src/middleware/authLockout.ts.
 *
 * The existing integration tests in tests/authLockout.test.ts cover the
 * happy-path lockout/reset/window/backoff scenarios via a real Express app.
 * These unit tests lock down the implicit edge cases:
 *
 *  1. store=null bypass — when no AuthAttemptStore has been configured,
 *     authLockoutMiddleware must call next() immediately without any lockout
 *     check (null-store is a valid "disabled" state, not an error).
 *
 *  2. store throws on isLockedOut — the middleware must not swallow the error;
 *     it must propagate it to next(err) so the error handler can respond.
 *
 *  3. IP resolves to 'unknown' — getClientIp() may return 'unknown' for
 *     requests that have no identifiable remote address. The middleware skips
 *     the IP lockout check in that case and only checks the body address.
 *
 *  4. Missing body address — when req.body.address is absent, only the IP
 *     check runs (no crash on undefined address lookup).
 *
 *  5. Both IP and address locked out — IP check fires first; 429 returned
 *     before the address check is reached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { AuthAttemptStore } from '../../../src/redis/authAttemptStore.js';

// ── Mock getClientIp so we control what "IP" the middleware sees ──────────────
vi.mock('../../../src/ws/connectionLimiter.js', () => ({
  getClientIp: vi.fn(),
}));

import { getClientIp } from '../../../src/ws/connectionLimiter.js';
import {
  authLockoutMiddleware,
  setAuthAttemptStore,
} from '../../../src/middleware/authLockout.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore(overrides: Partial<AuthAttemptStore> = {}): AuthAttemptStore {
  return {
    isLockedOut: vi.fn(async () => 0),
    recordFailure: vi.fn(async () => {}),
    recordSuccess: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AuthAttemptStore;
}

function makeReq(opts: { ip?: string; address?: string } = {}): Partial<Request> {
  return {
    body: opts.address !== undefined ? { address: opts.address } : {},
    authAttemptStore: undefined,
  };
}

function makeRes(): Partial<Response> {
  const res: any = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this._body = body; return this; },
    setHeader(name: string, value: string) { this._headers[name] = value; },
  };
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('authLockoutMiddleware — store=null bypass', () => {
  beforeEach(() => {
    // Ensure no store is registered (simulate "disabled" state).
    setAuthAttemptStore(null as any);
    (getClientIp as any).mockReturnValue('1.2.3.4');
  });

  afterEach(() => {
    setAuthAttemptStore(null as any);
    vi.clearAllMocks();
  });

  it('calls next() immediately without any lockout check when store is null', async () => {
    const req = makeReq({ address: 'GTEST' });
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error argument
    // IP mock should not matter because isLockedOut is never called
    expect(getClientIp).not.toHaveBeenCalled();
  });

  it('does not attach authAttemptStore to req when store is null', async () => {
    const req = makeReq({ address: 'GTEST' }) as any;
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    // The middleware only attaches store when the store is set
    expect(req.authAttemptStore).toBeUndefined();
  });
});

describe('authLockoutMiddleware — store throws on isLockedOut', () => {
  afterEach(() => {
    setAuthAttemptStore(null as any);
    vi.clearAllMocks();
  });

  it('propagates the error to next(err) when IP isLockedOut throws', async () => {
    const boom = new Error('Redis connection refused');
    const store = makeStore({ isLockedOut: vi.fn(async () => { throw boom; }) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('10.0.0.1');

    const req = makeReq({ address: 'GTEST' });
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect((res as any).statusCode).toBe(200); // no res.status() call — error forwarded
  });

  it('propagates the error to next(err) when address isLockedOut throws', async () => {
    const boom = new Error('Timeout on address lookup');
    // IP check passes (returns 0), address check throws
    const store = makeStore({
      isLockedOut: vi.fn(async (key: string) => {
        if (key === '10.0.0.1') return 0;
        throw boom;
      }),
    });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('10.0.0.1');

    const req = makeReq({ address: 'GTEST' });
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});

describe('authLockoutMiddleware — IP resolves to "unknown"', () => {
  afterEach(() => {
    setAuthAttemptStore(null as any);
    vi.clearAllMocks();
  });

  it('skips IP lockout check when IP is "unknown" and only checks body address', async () => {
    const store = makeStore({ isLockedOut: vi.fn(async () => 0) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('unknown');

    const req = makeReq({ address: 'GADDR' });
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    // isLockedOut should have been called for the address but NOT for 'unknown'
    expect(store.isLockedOut).toHaveBeenCalledWith('GADDR');
    expect(store.isLockedOut).not.toHaveBeenCalledWith('unknown');
  });

  it('calls next() when IP is "unknown" and there is no body address', async () => {
    const store = makeStore({ isLockedOut: vi.fn(async () => 0) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('unknown');

    const req = makeReq(); // no address in body
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(store.isLockedOut).not.toHaveBeenCalled();
  });

  it('returns 429 when body address is locked out even when IP is "unknown"', async () => {
    const store = makeStore({ isLockedOut: vi.fn(async () => 60) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('unknown');

    const req = makeReq({ address: 'LOCKED_ADDR' });
    const res = makeRes() as any;
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(res.statusCode).toBe(429);
    expect(res._headers['Retry-After']).toBe('60');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authLockoutMiddleware — missing body address', () => {
  afterEach(() => {
    setAuthAttemptStore(null as any);
    vi.clearAllMocks();
  });

  it('only checks IP lockout when body.address is absent', async () => {
    const store = makeStore({ isLockedOut: vi.fn(async () => 0) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('5.6.7.8');

    const req = makeReq(); // no address
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(store.isLockedOut).toHaveBeenCalledWith('5.6.7.8');
    expect(store.isLockedOut).toHaveBeenCalledTimes(1); // address check skipped
  });

  it('returns 429 via IP lockout when body.address is absent and IP is locked', async () => {
    const store = makeStore({ isLockedOut: vi.fn(async () => 120) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('5.6.7.8');

    const req = makeReq() as any;
    const res = makeRes() as any;
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(res.statusCode).toBe(429);
    expect(res._headers['Retry-After']).toBe('120');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authLockoutMiddleware — both IP and address locked', () => {
  afterEach(() => {
    setAuthAttemptStore(null as any);
    vi.clearAllMocks();
  });

  it('returns 429 based on IP lockout before reaching address check', async () => {
    // IP locked (60s), address also locked (120s), but IP is checked first.
    const store = makeStore({
      isLockedOut: vi.fn(async (key: string) => {
        if (key === '9.9.9.9') return 60;
        return 120; // address lockout — should never be reached
      }),
    });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('9.9.9.9');

    const req = makeReq({ address: 'GADDR_ALSO_LOCKED' }) as any;
    const res = makeRes() as any;
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(res.statusCode).toBe(429);
    expect(res._headers['Retry-After']).toBe('60'); // IP lockout value
    // isLockedOut called once for IP, address check never reached
    expect(store.isLockedOut).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authLockoutMiddleware — attaches store to request', () => {
  afterEach(() => {
    setAuthAttemptStore(null as any);
    vi.clearAllMocks();
  });

  it('attaches the store to req.authAttemptStore when request is allowed through', async () => {
    const store = makeStore({ isLockedOut: vi.fn(async () => 0) });
    setAuthAttemptStore(store);
    (getClientIp as any).mockReturnValue('1.2.3.4');

    const req = makeReq({ address: 'GTEST' }) as any;
    const res = makeRes();
    const next = vi.fn();

    await authLockoutMiddleware(req as Request, res as Response, next);

    expect(req.authAttemptStore).toBe(store);
    expect(next).toHaveBeenCalledOnce();
  });
});
