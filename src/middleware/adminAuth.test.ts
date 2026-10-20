/**
 * Unit tests for requireAdminAuth (#1809).
 *
 * Every collaborator (runtime env, metrics, JWT verification, logger, audit
 * log) is mocked, so the tests are synchronous, deterministic, and use no
 * network, no real clock and no real timers.
 */

import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const endTimer = vi.fn();
const startTimer = vi.fn(() => endTimer);

vi.mock('../config/runtime-env.js', () => ({ getRuntimeEnv: vi.fn() }));
vi.mock('../metrics/businessMetrics.js', () => ({
  authApiKeyLookupDurationSeconds: { startTimer: (...args: unknown[]) => (startTimer as any)(...args) },
}));
vi.mock('../lib/auth.js', () => ({ verifyToken: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ warn: vi.fn() }));
vi.mock('../lib/auditLog.js', () => ({ recordAuditEvent: vi.fn() }));

import { getRuntimeEnv } from '../config/runtime-env.js';
import { verifyToken } from '../lib/auth.js';
import { warn } from '../lib/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { requireAdminAuth } from './adminAuth.js';

const ADMIN_KEY = 'unit-test-admin-key-0123456789';
const MAX_HEADER = 8192;

interface FakeReq {
  headers: Record<string, string | undefined>;
  originalUrl?: string;
  path?: string;
  method: string;
  ip?: string;
  correlationId?: string;
  id?: string;
  user?: unknown;
}

function makeReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return {
    headers: {},
    originalUrl: '/admin/things?x=1',
    path: '/things',
    method: 'GET',
    ip: '203.0.113.7',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function run(req: FakeReq) {
  const res = makeRes();
  const next = vi.fn();
  requireAdminAuth(req as unknown as Request, res as unknown as Response, next as NextFunction);
  return { res, next };
}

const withAuth = (value: string | undefined, extra: Partial<FakeReq> = {}) =>
  makeReq({ headers: value === undefined ? {} : { authorization: value }, ...extra });

function setAdminKey(key: string | undefined): void {
  vi.mocked(getRuntimeEnv).mockReturnValue({ ADMIN_API_KEY: key } as never);
}

function expectRefusal(
  res: ReturnType<typeof makeRes>,
  next: ReturnType<typeof vi.fn>,
  status: number,
  code: string,
  reason: string,
) {
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(status);
  const body = res.json.mock.calls[0]![0];
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(recordAuditEvent).toHaveBeenCalledWith(
    'ADMIN_AUTH_REFUSED', 'auth', 'admin', expect.anything(), expect.objectContaining({ reason }),
  );
  expect(warn).toHaveBeenCalledTimes(1);
  expect(endTimer).toHaveBeenCalledTimes(1);
  expect(endTimer).toHaveBeenCalledWith({ outcome: 'failure' });
}

beforeEach(() => {
  setAdminKey(ADMIN_KEY);
  vi.mocked(verifyToken).mockImplementation(() => {
    throw new Error('not a jwt');
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('requireAdminAuth — normal path', () => {
  it('calls next() and attaches an admin user when the Bearer token equals ADMIN_API_KEY', () => {
    const req = withAuth(`Bearer ${ADMIN_KEY}`);
    const { res, next } = run(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ address: '', role: 'admin' });
    expect(endTimer).toHaveBeenCalledWith({ outcome: 'success' });
    expect(recordAuditEvent).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it.each(['admin', 'data-protection-officer'])('accepts a valid JWT whose role is %s', (role) => {
    const payload = { address: 'GABC', role };
    vi.mocked(verifyToken).mockReturnValue(payload as never);
    const req = withAuth('Bearer header.payload.sig');
    const { res, next } = run(req);

    expect(verifyToken).toHaveBeenCalledWith('header.payload.sig');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toBe(payload);
    expect(endTimer).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('starts exactly one timer per call and finishes it exactly once', () => {
    run(withAuth(`Bearer ${ADMIN_KEY}`));
    run(withAuth(undefined));
    expect(startTimer).toHaveBeenCalledTimes(2);
    expect(endTimer).toHaveBeenCalledTimes(2);
  });
});

describe('requireAdminAuth — fail closed when unconfigured', () => {
  it.each([undefined, ''])('answers 503 CONFIGURATION_ERROR when ADMIN_API_KEY is %j', (key) => {
    setAdminKey(key);
    const { res, next } = run(withAuth(`Bearer ${ADMIN_KEY}`));

    expectRefusal(res, next, 503, 'CONFIGURATION_ERROR', 'unconfigured');
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('refuses even a request with a valid-looking JWT when unconfigured', () => {
    setAdminKey(undefined);
    vi.mocked(verifyToken).mockReturnValue({ address: 'G', role: 'admin' } as never);
    const { res, next } = run(withAuth('Bearer a.b.c'));

    expectRefusal(res, next, 503, 'CONFIGURATION_ERROR', 'unconfigured');
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

describe('requireAdminAuth — Authorization header failures', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('answers 401 when the header is %s', (_label, value) => {
    const { res, next } = run(withAuth(value));
    expectRefusal(res, next, 401, 'UNAUTHORIZED', 'missing_header');
  });

  it('answers 401 oversized_header for a header one byte over the limit, before parsing', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');
    const header = 'Bearer ' + 'a'.repeat(MAX_HEADER + 1 - 'Bearer '.length);
    expect(header.length).toBe(MAX_HEADER + 1);

    const { res, next } = run(withAuth(header));

    expectRefusal(res, next, 401, 'UNAUTHORIZED', 'oversized_header');
    expect(splitSpy).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'ADMIN_AUTH_REFUSED', 'auth', 'admin', expect.anything(), expect.objectContaining({ headerLength: MAX_HEADER + 1 }),
    );
  });

  it('does not treat a header of exactly the maximum length as oversized', () => {
    const header = 'Bearer ' + 'a'.repeat(MAX_HEADER - 'Bearer '.length);
    expect(header.length).toBe(MAX_HEADER);

    const { res, next } = run(withAuth(header));

    // Goes through normal auth and fails there, not as oversized_header.
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it.each([
    ['Basic scheme', 'Basic abc'],
    ['lowercase bearer', 'bearer abc'],
    ['no scheme, just a token', ADMIN_KEY],
    ['three parts', 'Bearer abc def'],
    ['double space', 'Bearer  abc'],
    ['leading space', ' Bearer abc'],
  ])('answers 401 invalid_scheme for %s', (_label, header) => {
    const { res, next } = run(withAuth(header));
    expectRefusal(res, next, 401, 'UNAUTHORIZED', 'invalid_scheme');
  });

  it('answers 401 missing_token for "Bearer " with an empty token', () => {
    const { res, next } = run(withAuth('Bearer '));
    expectRefusal(res, next, 401, 'UNAUTHORIZED', 'missing_token');
  });
});

describe('requireAdminAuth — credential failures', () => {
  it('answers 403 for a wrong token of the same length', () => {
    const wrong = 'X'.repeat(ADMIN_KEY.length);
    const { res, next } = run(withAuth(`Bearer ${wrong}`));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it.each([
    ['one character shorter', ADMIN_KEY.slice(0, -1)],
    ['one character longer', ADMIN_KEY + 'x'],
    ['a single character', 'a'],
  ])('answers 403 for a token that is %s than the key', (_label, token) => {
    const { res, next } = run(withAuth(`Bearer ${token}`));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it('is case sensitive about the key', () => {
    const { res, next } = run(withAuth(`Bearer ${ADMIN_KEY.toUpperCase()}`));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it.each(['viewer', 'operator', 'user', undefined])('answers 403 for a valid JWT with role %s', (role) => {
    vi.mocked(verifyToken).mockReturnValue({ address: 'G', role } as never);
    const { res, next } = run(withAuth('Bearer a.b.c'));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it('answers 403 when JWT verification throws', () => {
    vi.mocked(verifyToken).mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const { res, next } = run(withAuth('Bearer a.b.c'));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it('answers 403 when JWT verification returns nothing', () => {
    vi.mocked(verifyToken).mockReturnValue(undefined as never);
    const { res, next } = run(withAuth('Bearer a.b.c'));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });

  it('works with a one-character ADMIN_API_KEY (minimum length boundary)', () => {
    setAdminKey('k');
    const ok = run(withAuth('Bearer k'));
    expect(ok.next).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const bad = run(withAuth('Bearer z'));
    expectRefusal(bad.res, bad.next, 403, 'FORBIDDEN', 'invalid_credentials');
  });
});

describe('requireAdminAuth — constant-time comparison', () => {
  it('compares equal-length tokens with crypto.timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    run(withAuth(`Bearer ${ADMIN_KEY}`));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not call timingSafeEqual for tokens of a different length', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    run(withAuth(`Bearer ${ADMIN_KEY}x`));
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to a manual comparison, still accepting the right key, if timingSafeEqual throws', () => {
    vi.spyOn(crypto, 'timingSafeEqual').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const { next } = run(withAuth(`Bearer ${ADMIN_KEY}`));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to a manual comparison, still rejecting a wrong key, if timingSafeEqual throws', () => {
    vi.spyOn(crypto, 'timingSafeEqual').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const wrong = ADMIN_KEY.slice(0, -1) + (ADMIN_KEY.endsWith('9') ? '8' : '9');
    const { res, next } = run(withAuth(`Bearer ${wrong}`));
    expectRefusal(res, next, 403, 'FORBIDDEN', 'invalid_credentials');
  });
});

describe('requireAdminAuth — logging, audit and response hygiene', () => {
  it('never puts token or key material in logs, audit entries or the response', () => {
    const secretToken = 'super-secret-wrong-token-value';
    const { res } = run(withAuth(`Bearer ${secretToken}`));

    const everything = JSON.stringify([
      vi.mocked(warn).mock.calls,
      vi.mocked(recordAuditEvent).mock.calls,
      res.json.mock.calls,
    ]);
    expect(everything).not.toContain(secretToken);
    expect(everything).not.toContain(ADMIN_KEY);
  });

  it('records the request path, method and ip in the audit entry', () => {
    run(withAuth(undefined, { originalUrl: '/admin/pause?force=1', method: 'POST', ip: '198.51.100.9' }));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'ADMIN_AUTH_REFUSED', 'auth', 'admin', 'corr-1',
      { reason: 'missing_header', path: '/admin/pause?force=1', method: 'POST', ip: '198.51.100.9' },
    );
  });

  it('falls back to req.path when originalUrl is missing', () => {
    run(withAuth(undefined, { originalUrl: undefined, path: '/only-path' }));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'ADMIN_AUTH_REFUSED', 'auth', 'admin', 'corr-1', expect.objectContaining({ path: '/only-path' }),
    );
  });

  it('uses req.id when no correlationId is set, and puts the id in the error body', () => {
    const { res } = run(withAuth(undefined, { correlationId: undefined, id: 'req-77' }));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'ADMIN_AUTH_REFUSED', 'auth', 'admin', 'req-77', expect.any(Object),
    );
    expect(res.json.mock.calls[0]![0].error.requestId).toBe('req-77');
  });

  it('copes with a request that has neither correlationId nor id', () => {
    const { res } = run(withAuth(undefined, { correlationId: undefined, id: undefined }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0]![0].error.requestId).toBeUndefined();
  });
});
