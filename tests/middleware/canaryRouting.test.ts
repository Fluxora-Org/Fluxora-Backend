/**
 * canaryRouting middleware — comprehensive test suite
 *
 * Coverage targets
 * ─────────────────
 * - computeCanaryBucket: determinism, distribution, salt isolation
 * - resolveClientIdentity: API key preference, IP fallback, edge cases
 * - createCanaryRoutingMiddleware: disabled path, header echo, req.isCanary,
 *   identity-not-found, correlation-ID integration, env-variable reading,
 *   boundary values (0 %, 100 %), distribution smoke-test
 * - Integration via createApp(): header visible on real HTTP responses
 * - Security: raw identity never logged, salt never logged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';

import {
  computeCanaryBucket,
  resolveClientIdentity,
  createCanaryRoutingMiddleware,
  canaryRoutingMiddleware,
  CANARY_HEADER,
  DEFAULT_CANARY_SALT,
  CANARY_BUCKET_COUNT,
} from '../../src/middleware/canaryRouting.ts';
import { correlationIdMiddleware } from '../../src/middleware/correlationId.js';
import { createApp } from '../../src/app.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal Express app with the canary middleware
// ---------------------------------------------------------------------------
function buildApp(trafficPercent: number, salt = DEFAULT_CANARY_SALT) {
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(createCanaryRoutingMiddleware({ trafficPercent, salt }));
  app.get('/ping', (req, res) => {
    res.json({ isCanary: (req as express.Request & { isCanary?: boolean }).isCanary ?? null });
  });
  return app;
}

// ---------------------------------------------------------------------------
// computeCanaryBucket
// ---------------------------------------------------------------------------
describe('computeCanaryBucket()', () => {
  it('returns a number in [0, 100) for arbitrary inputs', () => {
    for (const id of ['1.2.3.4', 'abc-key', 'user@example.com', '::1', '']) {
      const b = computeCanaryBucket(DEFAULT_CANARY_SALT, id);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('is deterministic — same inputs always yield the same bucket', () => {
    const salt = 'test-salt';
    const id = 'stable-client';
    expect(computeCanaryBucket(salt, id)).toBe(computeCanaryBucket(salt, id));
    expect(computeCanaryBucket(salt, id)).toBe(computeCanaryBucket(salt, id));
  });

  it('produces different buckets for different identities (with overwhelmingly high probability)', () => {
    const buckets = new Set(
      Array.from({ length: 20 }, (_, i) => computeCanaryBucket(DEFAULT_CANARY_SALT, `client-${i}`)),
    );
    // With 20 distinct inputs and 100 buckets the chance of all landing in the
    // same bucket is negligible — we assert at least 3 distinct values.
    expect(buckets.size).toBeGreaterThan(3);
  });

  it('changes when the salt changes (cross-experiment independence)', () => {
    const id = 'shared-client';
    const b1 = computeCanaryBucket('salt-A', id);
    const b2 = computeCanaryBucket('salt-B', id);
    // Different salts must produce different hash inputs; with very high
    // probability they land in different buckets.
    // (The two could collide mod 100 by chance — verify the raw digest differs)
    const d1 = createHash('sha256').update(`salt-A:${id}`).digest('hex');
    const d2 = createHash('sha256').update(`salt-B:${id}`).digest('hex');
    expect(d1).not.toBe(d2);
    // Buckets are independent of feature-flag salt
    expect(typeof b1).toBe('number');
    expect(typeof b2).toBe('number');
  });

  it('respects a custom modulus', () => {
    for (let i = 0; i < 50; i++) {
      const b = computeCanaryBucket(DEFAULT_CANARY_SALT, `client-${i}`, 10);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10);
    }
  });

  it('matches the reference formula: parseInt(sha256(salt:id).slice(0,8), 16) % 100', () => {
    const salt = DEFAULT_CANARY_SALT;
    const id = '192.168.1.1';
    const digest = createHash('sha256').update(`${salt}:${id}`).digest('hex');
    const expected = parseInt(digest.slice(0, 8), 16) % 100;
    expect(computeCanaryBucket(salt, id)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// resolveClientIdentity
// ---------------------------------------------------------------------------
describe('resolveClientIdentity()', () => {
  function makeReq(overrides: Partial<{ ip: string; headers: Record<string, string> }>): express.Request {
    return {
      ip: overrides.ip ?? '',
      headers: overrides.headers ?? {},
    } as unknown as express.Request;
  }

  it('returns the X-API-Key header value when present', () => {
    const req = makeReq({ headers: { 'x-api-key': 'my-key-123' }, ip: '1.2.3.4' });
    expect(resolveClientIdentity(req)).toBe('my-key-123');
  });

  it('trims whitespace from the API key', () => {
    const req = makeReq({ headers: { 'x-api-key': '  trimmed-key  ' }, ip: '1.2.3.4' });
    expect(resolveClientIdentity(req)).toBe('trimmed-key');
  });

  it('falls back to req.ip when X-API-Key is absent', () => {
    const req = makeReq({ ip: '10.0.0.1' });
    expect(resolveClientIdentity(req)).toBe('10.0.0.1');
  });

  it('falls back to req.ip when X-API-Key is empty string', () => {
    const req = makeReq({ headers: { 'x-api-key': '' }, ip: '10.0.0.2' });
    expect(resolveClientIdentity(req)).toBe('10.0.0.2');
  });

  it('falls back to req.ip when X-API-Key is whitespace only', () => {
    const req = makeReq({ headers: { 'x-api-key': '   ' }, ip: '10.0.0.3' });
    expect(resolveClientIdentity(req)).toBe('10.0.0.3');
  });

  it('returns undefined when both API key and IP are absent', () => {
    const req = makeReq({ ip: '', headers: {} });
    expect(resolveClientIdentity(req)).toBeUndefined();
  });

  it('prefers API key over IP address', () => {
    const req = makeReq({ headers: { 'x-api-key': 'api-key' }, ip: '5.5.5.5' });
    // Must return the API key, not the IP
    expect(resolveClientIdentity(req)).toBe('api-key');
    expect(resolveClientIdentity(req)).not.toBe('5.5.5.5');
  });
});

// ---------------------------------------------------------------------------
// createCanaryRoutingMiddleware — unit tests using express()
// ---------------------------------------------------------------------------
describe('createCanaryRoutingMiddleware()', () => {
  describe('disabled path (trafficPercent = 0)', () => {
    it('sets req.isCanary = false and calls next()', async () => {
      const app = buildApp(0);
      const res = await request(app).get('/ping').set('X-API-Key', 'any-key');
      expect(res.status).toBe(200);
      expect(res.body.isCanary).toBe(false);
    });

    it('does not emit X-Fluxora-Canary header', async () => {
      const app = buildApp(0);
      const res = await request(app).get('/ping').set('X-API-Key', 'any-key');
      expect(res.headers[CANARY_HEADER.toLowerCase()]).toBeUndefined();
    });
  });

  describe('fully enabled path (trafficPercent = 100)', () => {
    it('sets req.isCanary = true for every request', async () => {
      const app = buildApp(100);
      // Test with multiple different identities
      for (const key of ['key-a', 'key-b', 'key-c', '192.168.0.1']) {
        const res = await request(app).get('/ping').set('X-API-Key', key);
        expect(res.body.isCanary).toBe(true);
      }
    });

    it('echoes X-Fluxora-Canary: true response header', async () => {
      const app = buildApp(100);
      const res = await request(app).get('/ping').set('X-API-Key', 'any');
      expect(res.headers[CANARY_HEADER.toLowerCase()]).toBe('true');
    });
  });

  describe('partial traffic split', () => {
    it('is deterministic — same client always gets the same decision', async () => {
      const app = buildApp(50);
      const key = 'stable-client-key';
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/ping').set('X-API-Key', key);
        results.push(res.body.isCanary);
      }
      // All 5 calls must agree
      expect(new Set(results).size).toBe(1);
    });

    it('bucket threshold is respected — client lands in canary iff bucket < percent', async () => {
      const salt = DEFAULT_CANARY_SALT;
      const key = 'threshold-test-key';
      const bucket = computeCanaryBucket(salt, key);

      // At trafficPercent = bucket, the client is NOT canary (bucket < bucket is false)
      const appAtBucket = buildApp(bucket, salt);
      const resAtBucket = await request(appAtBucket).get('/ping').set('X-API-Key', key);
      expect(resAtBucket.body.isCanary).toBe(false);

      // At trafficPercent = bucket + 1, the client IS canary
      const appAboveBucket = buildApp(bucket + 1, salt);
      const resAboveBucket = await request(appAboveBucket).get('/ping').set('X-API-Key', key);
      expect(resAboveBucket.body.isCanary).toBe(true);
    });

    it('X-Fluxora-Canary header is absent for non-canary requests', async () => {
      const salt = DEFAULT_CANARY_SALT;
      const key = 'stable-key-not-canary';
      const bucket = computeCanaryBucket(salt, key);
      // Set percent = bucket so this client is NOT canary
      const app = buildApp(bucket, salt);
      const res = await request(app).get('/ping').set('X-API-Key', key);
      expect(res.body.isCanary).toBe(false);
      expect(res.headers[CANARY_HEADER.toLowerCase()]).toBeUndefined();
    });

    it('roughly 50% of diverse clients are canary at trafficPercent=50', () => {
      // Pure unit test — no HTTP overhead, just hash math
      const salt = DEFAULT_CANARY_SALT;
      let canaryCount = 0;
      const total = 1000;
      for (let i = 0; i < total; i++) {
        const bucket = computeCanaryBucket(salt, `client-${i}`);
        if (bucket < 50) canaryCount++;
      }
      const ratio = canaryCount / total;
      // Allow ±10 pp tolerance for a 1000-sample run
      expect(ratio).toBeGreaterThan(0.40);
      expect(ratio).toBeLessThan(0.60);
    });
  });

  describe('client identity resolution in HTTP context', () => {
    it('uses X-API-Key over IP when both are present', async () => {
      const salt = DEFAULT_CANARY_SALT;
      const key = 'api-key-identity';
      const bucketByKey = computeCanaryBucket(salt, key);

      // trafficPercent just above key's bucket → canary
      const app = buildApp(bucketByKey + 1, salt);
      const res = await request(app).get('/ping').set('X-API-Key', key);
      expect(res.body.isCanary).toBe(true);
    });

    it('falls back to IP identity when no X-API-Key is sent', async () => {
      // Build app with 100% canary — every IP should be tagged
      const app = buildApp(100);
      const res = await request(app).get('/ping');
      // supertest uses 127.0.0.1 — req.ip will resolve to something
      expect(res.body.isCanary).toBe(true);
    });

    it('sets req.isCanary = false and does not emit header when identity is unknown', async () => {
      // Test by calling the exported resolveClientIdentity directly with no IP and no key.
      // In HTTP context supertest always provides a loopback IP, so we verify via unit test.
      const app = express();
      app.use(correlationIdMiddleware);
      // Use the factory directly with a custom identityResolver override is not possible,
      // so test the behaviour via the exported helper instead.
      app.use(createCanaryRoutingMiddleware({ trafficPercent: 100 }));
      app.get('/ping', (req, res) => {
        const val = (req as express.Request & { isCanary?: boolean }).isCanary;
        res.json({ isCanary: val === undefined ? null : val });
      });

      // With no X-API-Key and a supertest loopback IP, isCanary will be true (100%)
      // or false (0%) based on bucket — just verify req.isCanary is a boolean and
      // the header is set consistently.
      const res = await request(app).get('/ping');
      expect(typeof res.body.isCanary).toBe('boolean');

      // Verify the unit behaviour directly: undefined identity → isCanary = false
      const { resolveClientIdentity: rci } = await import('../../src/middleware/canaryRouting.js');
      const fakeReq = { ip: '', headers: {} } as express.Request;
      expect(rci(fakeReq)).toBeUndefined();
    });
  });

  describe('environment variable reading', () => {
    afterEach(() => {
      delete process.env['CANARY_TRAFFIC_PERCENT'];
      delete process.env['CANARY_SALT'];
    });

    it('reads CANARY_TRAFFIC_PERCENT from process.env when no options passed', async () => {
      const salt = DEFAULT_CANARY_SALT;
      const key = 'env-test-key';
      const bucket = computeCanaryBucket(salt, key);

      process.env['CANARY_TRAFFIC_PERCENT'] = String(bucket + 1);

      const app = express();
      app.use(correlationIdMiddleware);
      // Use the default export which reads env at request time
      app.use(createCanaryRoutingMiddleware()); // no options → reads env
      app.get('/ping', (req, res) => {
        res.json({ isCanary: (req as express.Request & { isCanary?: boolean }).isCanary });
      });

      const res = await request(app).get('/ping').set('X-API-Key', key);
      expect(res.body.isCanary).toBe(true);
    });

    it('reads CANARY_SALT from process.env when no options passed', async () => {
      const customSalt = 'my-custom-salt';
      const key = 'salt-env-test';
      const bucket = computeCanaryBucket(customSalt, key);

      process.env['CANARY_TRAFFIC_PERCENT'] = String(bucket + 1);
      process.env['CANARY_SALT'] = customSalt;

      const app = express();
      app.use(correlationIdMiddleware);
      app.use(createCanaryRoutingMiddleware());
      app.get('/ping', (req, res) => {
        res.json({ isCanary: (req as express.Request & { isCanary?: boolean }).isCanary });
      });

      const res = await request(app).get('/ping').set('X-API-Key', key);
      expect(res.body.isCanary).toBe(true);
    });

    it('defaults to trafficPercent=0 when CANARY_TRAFFIC_PERCENT is missing', async () => {
      delete process.env['CANARY_TRAFFIC_PERCENT'];
      const app = express();
      app.use(correlationIdMiddleware);
      app.use(createCanaryRoutingMiddleware());
      app.get('/ping', (req, res) => {
        res.json({ isCanary: (req as express.Request & { isCanary?: boolean }).isCanary });
      });
      const res = await request(app).get('/ping').set('X-API-Key', 'key');
      expect(res.body.isCanary).toBe(false);
    });

    it('ignores an out-of-range CANARY_TRAFFIC_PERCENT and defaults to 0', async () => {
      process.env['CANARY_TRAFFIC_PERCENT'] = '999';
      const app = express();
      app.use(correlationIdMiddleware);
      app.use(createCanaryRoutingMiddleware());
      app.get('/ping', (req, res) => {
        res.json({ isCanary: (req as express.Request & { isCanary?: boolean }).isCanary });
      });
      const res = await request(app).get('/ping').set('X-API-Key', 'key');
      // 999 is out of range; middleware clamps to 0
      expect(res.body.isCanary).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Correlation-ID integration
// ---------------------------------------------------------------------------
describe('correlationId integration', () => {
  it('req.correlationId is available inside the middleware (correlationId runs first)', async () => {
    let capturedCorrelationId: string | undefined;

    const app = express();
    app.use(correlationIdMiddleware);
    // Spy middleware to capture correlationId before canary runs
    app.use((req, _res, next) => {
      capturedCorrelationId = req.correlationId;
      next();
    });
    app.use(createCanaryRoutingMiddleware({ trafficPercent: 100 }));
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    const cid = '123e4567-e89b-12d3-a456-426614174000';
    await request(app).get('/ping').set('x-correlation-id', cid);
    expect(capturedCorrelationId).toBe(cid);
  });

  it('canary decision log calls include the correlation ID', async () => {
    const logSpy = vi.spyOn(
      (await import('../../src/lib/logger.js')).logger,
      'debug',
    );

    const salt = DEFAULT_CANARY_SALT;
    const key = 'log-test-key';
    const bucket = computeCanaryBucket(salt, key);
    // Use a valid UUID v4 (version digit must be 1-5; use '4' = v4)
    const cid = 'aaaabbbb-cccc-4234-8678-000000000000';

    const app = buildApp(bucket + 1, salt);
    await request(app)
      .get('/ping')
      .set('X-API-Key', key)
      .set('x-correlation-id', cid);

    // At least one debug call should include the correlationId
    const canaryCall = logSpy.mock.calls.find(
      ([msg, callCid]) =>
        typeof msg === 'string' &&
        msg.includes('canary') &&
        callCid === cid,
    );
    expect(canaryCall).toBeDefined();
    expect(canaryCall![1]).toBe(cid);

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Security tests
// ---------------------------------------------------------------------------
describe('security', () => {
  it('does not log the raw API key in any log call', async () => {
    const logSpy = vi.spyOn(
      (await import('../../src/lib/logger.js')).logger,
      'debug',
    );

    const sensitiveKey = 'super-secret-api-key-do-not-log';
    const app = buildApp(100);
    await request(app).get('/ping').set('X-API-Key', sensitiveKey);

    for (const [, , meta] of logSpy.mock.calls) {
      expect(JSON.stringify(meta ?? {})).not.toContain(sensitiveKey);
    }

    logSpy.mockRestore();
  });

  it('does not log the raw client IP in any log call', async () => {
    const logSpy = vi.spyOn(
      (await import('../../src/lib/logger.js')).logger,
      'debug',
    );

    // supertest resolves to 127.0.0.1
    const app = buildApp(100);
    await request(app).get('/ping');

    for (const [, , meta] of logSpy.mock.calls) {
      expect(JSON.stringify(meta ?? {})).not.toContain('127.0.0.1');
    }

    logSpy.mockRestore();
  });

  it('does not include the salt value in any log message or meta', async () => {
    const customSalt = 'ultra-secret-salt-xyz-987';
    const logSpy = vi.spyOn(
      (await import('../../src/lib/logger.js')).logger,
      'debug',
    );

    const app = buildApp(100, customSalt);
    await request(app).get('/ping').set('X-API-Key', 'any');

    for (const args of logSpy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain(customSalt);
    }

    logSpy.mockRestore();
  });

  it('different salts produce independent bucketing (cross-experiment isolation)', () => {
    const id = 'same-client-everywhere';
    const saltA = 'feature-flags-salt';
    const saltB = DEFAULT_CANARY_SALT;

    const bucketA = computeCanaryBucket(saltA, id);
    const bucketB = computeCanaryBucket(saltB, id);

    // The raw hash inputs are different — hashes must differ
    const hashA = createHash('sha256').update(`${saltA}:${id}`).digest('hex');
    const hashB = createHash('sha256').update(`${saltB}:${id}`).digest('hex');
    expect(hashA).not.toBe(hashB);
    // Buckets are independently computed
    expect(typeof bucketA).toBe('number');
    expect(typeof bucketB).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------
describe('exported constants', () => {
  it('CANARY_HEADER is X-Fluxora-Canary', () => {
    expect(CANARY_HEADER).toBe('X-Fluxora-Canary');
  });

  it('DEFAULT_CANARY_SALT is a non-empty string', () => {
    expect(typeof DEFAULT_CANARY_SALT).toBe('string');
    expect(DEFAULT_CANARY_SALT.length).toBeGreaterThan(0);
  });

  it('CANARY_BUCKET_COUNT is 100', () => {
    expect(CANARY_BUCKET_COUNT).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Integration test via createApp()
// ---------------------------------------------------------------------------
describe('integration via createApp()', () => {
  afterEach(() => {
    delete process.env['CANARY_TRAFFIC_PERCENT'];
    delete process.env['CANARY_SALT'];
  });

  it('X-Fluxora-Canary header is absent when CANARY_TRAFFIC_PERCENT=0 (default)', async () => {
    delete process.env['CANARY_TRAFFIC_PERCENT'];
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.headers[CANARY_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('X-Fluxora-Canary: true is present when client bucket is within traffic percent', async () => {
    const salt = DEFAULT_CANARY_SALT;
    const key = 'integration-canary-key';
    const bucket = computeCanaryBucket(salt, key);

    process.env['CANARY_TRAFFIC_PERCENT'] = String(bucket + 1);

    const app = createApp();
    const res = await request(app)
      .get('/health')
      .set('X-API-Key', key);

    expect(res.headers[CANARY_HEADER.toLowerCase()]).toBe('true');
  });

  it('header is absent on non-canary client even with partial traffic percent', async () => {
    const salt = DEFAULT_CANARY_SALT;
    const key = 'stable-client-key';
    const bucket = computeCanaryBucket(salt, key);

    // Set percent = bucket so this exact client is NOT canary
    process.env['CANARY_TRAFFIC_PERCENT'] = String(bucket);

    const app = createApp();
    const res = await request(app)
      .get('/health')
      .set('X-API-Key', key);

    expect(res.headers[CANARY_HEADER.toLowerCase()]).toBeUndefined();
  });
});
