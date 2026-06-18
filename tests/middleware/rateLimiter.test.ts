import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createRateLimiter, extractClientIdentifier, isAdminKey } from '../../src/middleware/rateLimiter.js';
import { InMemoryStore } from '../../src/redis/rateLimitStore.js';

function mockRequest(props: Partial<Request> = {}): Request & { ip?: string } {
  return {
    headers: {},
    socket: { remoteAddress: '10.0.0.1' } as any,
    // Use a path that does not match any ROUTE_BUDGETS so the env-driven
    // limits in this test apply directly.
    path: '/__rate-limit-test__',
    method: 'GET',
    ip: '10.0.0.1',
    ...props,
  } as Request & { ip?: string };
}

function mockResponse() {
  const res: Partial<Response> = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as Response & { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function mockNext(): NextFunction {
  return vi.fn();
}

/** Helper: invoke the async middleware and wait for it to settle. */
async function invoke(
  limiter: ReturnType<typeof createRateLimiter>,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const origJson = (res as any).json as (...a: unknown[]) => unknown;
  return new Promise<void>((resolve, reject) => {
    const origNext = next as (...a: unknown[]) => void;
    const wrappedNext: NextFunction = (...args) => {
      origNext(...args);
      (res as any).json = origJson; // restore
      resolve();
    };
    // Patch res.json to resolve the promise when called (for 429 responses)
    (res as any).json = (...args: unknown[]) => {
      const result = origJson.call(res, ...args);
      (res as any).json = origJson; // restore
      resolve();
      return result;
    };
    try {
      limiter(req, res, wrappedNext);
    } catch (err) {
      (res as any).json = origJson;
      reject(err);
    }
  });
}

describe('extractClientIdentifier', () => {
  it('returns ip when no x-api-key header', () => {
    const req = mockRequest({ headers: {} });
    const result = extractClientIdentifier(req);
    expect(result.identifierType).toBe('ip');
    expect(result.identifier).toBe('10.0.0.1');
  });

  it('returns apiKey when x-api-key header present', () => {
    const req = mockRequest({ headers: { 'x-api-key': 'test-key-123' } });
    const result = extractClientIdentifier(req);
    expect(result.identifierType).toBe('apiKey');
    expect(result.identifier).toBe('test-key-123');
  });

  it('prefers ip when x-api-key is empty string', () => {
    const req = mockRequest({ headers: { 'x-api-key': '' } });
    const result = extractClientIdentifier(req);
    expect(result.identifierType).toBe('ip');
  });
});

describe('isAdminKey', () => {
  it('returns false when no admin key configured', () => {
    const env: Record<string, string | undefined> = {};
    expect(isAdminKey('any-key', env)).toBe(false);
  });

  it('returns true when key matches admin key', () => {
    const env: Record<string, string | undefined> = { ADMIN_API_KEY: 'admin-secret' };
    expect(isAdminKey('admin-secret', env)).toBe(true);
  });

  it('returns false when key does not match', () => {
    const env: Record<string, string | undefined> = { ADMIN_API_KEY: 'admin-secret' };
    expect(isAdminKey('wrong-key', env)).toBe(false);
  });

  it('handles comma-separated admin keys', () => {
    const env: Record<string, string | undefined> = { ADMIN_API_KEY: 'key1, key2 , key3' };
    expect(isAdminKey('key2', env)).toBe(true);
    expect(isAdminKey('key1', env)).toBe(true);
    expect(isAdminKey('key3', env)).toBe(true);
    expect(isAdminKey('key4', env)).toBe(false);
  });
});

describe('rate limiter middleware', () => {
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = {
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_IP_MAX: '3',
      RATE_LIMIT_IP_WINDOW_MS: '60000',
      RATE_LIMIT_APIKEY_MAX: '5',
      RATE_LIMIT_APIKEY_WINDOW_MS: '60000',
      RATE_LIMIT_ADMIN_MAX: '10',
      RATE_LIMIT_ADMIN_WINDOW_MS: '60000',
      RATE_LIMIT_TRUST_PROXY: 'false',
    };
  });

  it('passes through when under limit', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());
    const req = mockRequest({ headers: {}, ip: '5.5.5.5' });
    const res = mockResponse();
    const next = mockNext();

    await invoke(limiter, req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '3');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '2');
  });

  it('returns 429 with correct body when IP limit exceeded', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());
    const req = mockRequest({ headers: {}, ip: '5.5.5.5' });
    const res = mockResponse();
    const next = mockNext();

    // Hit limit: 3 requests
    for (let i = 0; i < 3; i++) {
      await invoke(limiter, req, res, next);
    }

    // 4th request should be rate limited
    const fourthNext = mockNext();
    await invoke(limiter, req, res, fourthNext);

    expect(fourthNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'RATE_LIMIT_EXCEEDED',
          limit: 3,
          window: 'minute',
        }),
      })
    );
  });

  it('applies separate counters for different IPs', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());

    const req1 = mockRequest({ headers: {}, ip: '1.1.1.1' });
    const req2 = mockRequest({ headers: {}, ip: '2.2.2.2' });
    const res1 = mockResponse();
    const res2 = mockResponse();
    const next1 = mockNext();
    const next2 = mockNext();

    // Both IPs get their own 3-request budget
    await invoke(limiter, req1, res1, next1); // count=1
    await invoke(limiter, req1, res1, next1); // count=2
    await invoke(limiter, req1, res1, next1); // count=3
    await invoke(limiter, req1, res1, next1); // blocked

    await invoke(limiter, req2, res2, next2); // starts fresh with count=1
    expect(next2).toHaveBeenCalled();
  });

  it('applies separate counters for different API keys', async () => {
    env.RATE_LIMIT_APIKEY_MAX = '2';

    const limiter = createRateLimiter(env, new InMemoryStore());

    const req1 = mockRequest({ headers: { 'x-api-key': 'partner-a' } });
    const req2 = mockRequest({ headers: { 'x-api-key': 'partner-b' } });
    const res1 = mockResponse();
    const res2 = mockResponse();
    const next1 = mockNext();
    const next2 = mockNext();

    await invoke(limiter, req1, res1, next1); // partner-a count=1
    await invoke(limiter, req1, res1, next1); // partner-a count=2
    await invoke(limiter, req1, res1, next1); // partner-a blocked

    // partner-b starts fresh
    await invoke(limiter, req2, res2, next2); // partner-b count=1
    expect(next2).toHaveBeenCalled();
  });

  it('uses higher admin limit for admin API key', async () => {
    env.ADMIN_API_KEY = 'admin-top-secret';
    env.RATE_LIMIT_APIKEY_MAX = '2';
    env.RATE_LIMIT_ADMIN_MAX = '10';

    const limiter = createRateLimiter(env, new InMemoryStore());

    const req = mockRequest({ headers: { 'x-api-key': 'admin-top-secret' }, ip: '1.1.1.1' });
    const res = mockResponse();
    const next = mockNext();

    // Admin gets 10 requests
    for (let i = 0; i < 10; i++) {
      await invoke(limiter, req, res, next);
    }

    // 11th request blocked
    const eleventhNext = mockNext();
    await invoke(limiter, req, res, eleventhNext);
    expect(eleventhNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('exempts /health endpoint', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());
    const req = mockRequest({ headers: {}, ip: '9.9.9.9', path: '/health' });
    const res = mockResponse();
    const next = mockNext();

    // Exhaust IP limit
    for (let i = 0; i < 5; i++) {
      await invoke(limiter, req, res, next);
    }

    // /health should still pass
    const healthNext = mockNext();
    await invoke(limiter, req, res, healthNext);
    expect(healthNext).toHaveBeenCalled();
  });

  it('exempts / root endpoint', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());
    const req = mockRequest({ headers: {}, ip: '9.9.9.9', path: '/' });
    const res = mockResponse();
    const next = mockNext();

    for (let i = 0; i < 5; i++) {
      await invoke(limiter, req, res, next);
    }

    const rootNext = mockNext();
    await invoke(limiter, req, res, rootNext);
    expect(rootNext).toHaveBeenCalled();
  });

  it('sets standard rate limit headers on every response', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());
    const req = mockRequest({ headers: {}, ip: '7.7.7.7' });
    const res = mockResponse();
    const next = mockNext();

    await invoke(limiter, req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '3');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });

  it('disabled rate limiting when RATE_LIMIT_ENABLED=false', async () => {
    env.RATE_LIMIT_ENABLED = 'false';
    const limiter = createRateLimiter(env, new InMemoryStore());

    const req = mockRequest({ headers: {}, ip: '5.5.5.5' });
    const res = mockResponse();
    const next = mockNext();

    for (let i = 0; i < 100; i++) {
      await invoke(limiter, req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(100);
  });

  it('correctly reports remaining after some requests', async () => {
    const limiter = createRateLimiter(env, new InMemoryStore());
    const req = mockRequest({ headers: {}, ip: '4.4.4.4' });
    const res = mockResponse();
    const next = mockNext();

    await invoke(limiter, req, res, next); // count=1, remaining=2
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '2');

    await invoke(limiter, req, res, next); // count=2, remaining=1
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');

    await invoke(limiter, req, res, next); // count=3, remaining=0
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
  });

  it('handles missing remote address gracefully', () => {
    const req = mockRequest({ headers: {}, socket: {} as any, ip: undefined });
    const result = extractClientIdentifier(req);
    expect(result.identifierType).toBe('ip');
    expect(result.identifier).toBe('unknown');
  });
});

describe('getStatus', () => {
  it('returns correct status for IP identifier', async () => {
    const limiter = createRateLimiter({
      RATE_LIMIT_IP_MAX: '5',
      RATE_LIMIT_IP_WINDOW_MS: '60000',
      RATE_LIMIT_ENABLED: 'true',
    }, new InMemoryStore());

    const status = await limiter.getStatus('3.3.3.3', 'ip');
    expect(status.identifier).toBe('3.3.3.3');
    expect(status.identifierType).toBe('ip');
    expect(status.limit).toBe(5);
    expect(status.remaining).toBe(5);
    expect(status.window).toBe('minute');
    expect(status.resetsAt).toBeDefined();
  });

  it('returns masked identifier for API key', async () => {
    const limiter = createRateLimiter({
      RATE_LIMIT_APIKEY_MAX: '5',
      RATE_LIMIT_APIKEY_WINDOW_MS: '60000',
      RATE_LIMIT_ENABLED: 'true',
    }, new InMemoryStore());

    const status = await limiter.getStatus('my-very-long-api-key-12345', 'apiKey');
    expect(status.identifier).toBe('my-v...2345');
    expect(status.identifierType).toBe('apiKey');
  });
});
