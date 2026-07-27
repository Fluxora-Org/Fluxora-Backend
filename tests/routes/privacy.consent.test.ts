/**
 * Comprehensive integration tests for CCPA/BIPA consent-preference endpoints:
 *   - PUT /api/privacy/consent
 *   - GET /api/privacy/consent/:address
 *
 * Issue #731 requirements:
 *   - Consent state queryable by computeAddressHash so no plaintext address is stored.
 *   - Writes validated by Zod schema and idempotent (last-write-wins).
 *   - Minimum 95% test coverage.
 *   - Security, headers, edge cases, error handling, 405 method rejection.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { computeAddressHash } from '../../src/pii/pgcryptoEncryption.js';
import { PoolExhaustedError } from '../../src/db/pool.js';
import { loadConfig } from '../../src/config/env.js';

// ── Mock database pool ───────────────────────────────────────────────────────
const mockQuery = vi.hoisted(() => vi.fn());
const mockGetPool = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pool.js')>();
  return {
    ...actual,
    getPool: mockGetPool,
    query: mockQuery,
  };
});

import { createApp } from '../../src/app.js';

const TEST_KEY = 'test-pgcrypto-key-32-chars-long-abc';
const VALID_ADDRESS = 'GAG6S322PSTN7N6WGAO57O2B7VUXR57WCS72VTLGXR2V4YOWHNYYXY5Z';
const VALID_ADDRESS_2 = 'GBVHH3J75FGBMXX4YVGUS5O24W3GWTQ6O3GOHYVEXROFFY2VXYW6Z3XN';
const INVALID_ADDRESS = 'not-a-valid-stellar-public-key';

describe('CCPA/BIPA Privacy Consent Endpoints', () => {
  let app: ReturnType<typeof createApp>;
  let inMemoryDb: Map<
    string,
    {
      analytics_optout: boolean;
      marketing_optout: boolean;
      biometric_processing_consent: boolean;
      created_at: Date;
      updated_at: Date;
    }
  >;

  beforeAll(() => {
    process.env['PGCRYPTO_KEY'] = TEST_KEY;
    const baseConfig = loadConfig();
    const testConfig = { ...baseConfig, pgcryptoKey: TEST_KEY };
    app = createApp({ config: testConfig });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryDb = new Map();

    // Mock query implementation simulating privacy_consents SQL table operations
    mockQuery.mockImplementation(async (_pool: unknown, sql: string, params: unknown[]) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql.includes('INSERT INTO privacy_consents')) {
        const [addressHash, analyticsOptout, marketingOptout, biometricConsent] = params as [
          string,
          boolean,
          boolean,
          boolean,
        ];

        const existing = inMemoryDb.get(addressHash);
        const now = new Date();
        const created_at = existing ? existing.created_at : now;
        const updated_at = now;

        const record = {
          analytics_optout: Boolean(analyticsOptout),
          marketing_optout: Boolean(marketingOptout),
          biometric_processing_consent: Boolean(biometricConsent),
          created_at,
          updated_at,
        };

        inMemoryDb.set(addressHash, record);
        return { rows: [record] };
      }

      if (normalizedSql.includes('SELECT analytics_optout')) {
        const [addressHash] = params as [string];
        const record = inMemoryDb.get(addressHash);
        return { rows: record ? [record] : [] };
      }

      return { rows: [] };
    });
  });

  // ── PUT /api/privacy/consent ──────────────────────────────────────────────

  describe('PUT /api/privacy/consent', () => {
    it('successfully creates recipient consent preferences and returns 200 with consent state', async () => {
      const payload = {
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: true,
      };

      const res = await request(app).put('/api/privacy/consent').send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.consent).toMatchObject({
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: true,
      });
      expect(typeof res.body.data.consent.created_at).toBe('string');
      expect(typeof res.body.data.consent.updated_at).toBe('string');

      // Verify that plaintext address is NEVER passed to DB or returned in body
      const expectedHash = computeAddressHash(VALID_ADDRESS, TEST_KEY);
      expect(mockQuery).toHaveBeenCalled();
      const [, , params] = mockQuery.mock.calls[0];
      expect(params[0]).toBe(expectedHash);
      expect(JSON.stringify(res.body)).not.toContain(VALID_ADDRESS);
      expect(JSON.stringify(res.body)).not.toContain(expectedHash);
    });

    it('enforces idempotency (last-write-wins) when updating existing consent', async () => {
      const payload1 = {
        address: VALID_ADDRESS,
        analytics_optout: false,
        marketing_optout: false,
        biometric_processing_consent: false,
      };

      const res1 = await request(app).put('/api/privacy/consent').send(payload1);
      expect(res1.status).toBe(200);
      expect(res1.body.data.consent.analytics_optout).toBe(false);
      const createdAt1 = res1.body.data.consent.created_at;

      const payload2 = {
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: true,
        biometric_processing_consent: false,
      };

      const res2 = await request(app).put('/api/privacy/consent').send(payload2);
      expect(res2.status).toBe(200);
      expect(res2.body.data.consent).toMatchObject({
        analytics_optout: true,
        marketing_optout: true,
        biometric_processing_consent: false,
      });
      // created_at should remain unchanged
      expect(res2.body.data.consent.created_at).toBe(createdAt1);
    });

    it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff headers', async () => {
      const payload = {
        address: VALID_ADDRESS,
        analytics_optout: false,
        marketing_optout: true,
        biometric_processing_consent: false,
      };

      const res = await request(app).put('/api/privacy/consent').send(payload);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns 400 validation error when address is invalid or missing', async () => {
      const resMissing = await request(app).put('/api/privacy/consent').send({
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: false,
      });
      expect(resMissing.status).toBe(400);
      expect(resMissing.body.error.code).toBe('VALIDATION_ERROR');

      const resInvalid = await request(app).put('/api/privacy/consent').send({
        address: INVALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: false,
      });
      expect(resInvalid.status).toBe(400);
      expect(resInvalid.body.error.code).toBe('VALIDATION_ERROR');
      expect(resInvalid.body.error.message).toContain('address');
    });

    it('returns 400 validation error when optout fields are missing or not boolean', async () => {
      const resNonBool = await request(app).put('/api/privacy/consent').send({
        address: VALID_ADDRESS,
        analytics_optout: 'yes',
        marketing_optout: false,
        biometric_processing_consent: false,
      });
      expect(resNonBool.status).toBe(400);
      expect(resNonBool.body.error.code).toBe('VALIDATION_ERROR');

      const resMissingField = await request(app).put('/api/privacy/consent').send({
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
      });
      expect(resMissingField.status).toBe(400);
      expect(resMissingField.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 validation error when extra unrecognized fields are supplied (strict object rule)', async () => {
      const resExtra = await request(app).put('/api/privacy/consent').send({
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: false,
        unknown_field: 'unallowed',
      });
      expect(resExtra.status).toBe(400);
      expect(resExtra.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 405 Method Not Allowed with Allow header for unsupported HTTP verbs', async () => {
      const resPost = await request(app).post('/api/privacy/consent').send({});
      expect(resPost.status).toBe(405);
      expect(resPost.headers['allow']).toBe('PUT');
      expect(resPost.body.error.code).toBe('METHOD_NOT_ALLOWED');

      const resDelete = await request(app).delete('/api/privacy/consent');
      expect(resDelete.status).toBe(405);
      expect(resDelete.headers['allow']).toBe('PUT');
    });
  });

  // ── GET /api/privacy/consent/:address ─────────────────────────────────────

  describe('GET /api/privacy/consent/:address', () => {
    it('returns 200 with consent state for an existing record', async () => {
      // Seed consent
      await request(app).put('/api/privacy/consent').send({
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: true,
      });

      const res = await request(app).get(`/api/privacy/consent/${VALID_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.consent).toMatchObject({
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: true,
      });
      expect(typeof res.body.data.consent.created_at).toBe('string');
      expect(typeof res.body.data.consent.updated_at).toBe('string');

      // Verify that query looked up by HMAC address hash
      const expectedHash = computeAddressHash(VALID_ADDRESS, TEST_KEY);
      const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
      expect(lastCall[2][0]).toBe(expectedHash);
    });

    it('returns 404 NOT_FOUND when consent record does not exist', async () => {
      const res = await request(app).get(`/api/privacy/consent/${VALID_ADDRESS_2}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('Privacy consent');
    });

    it('returns 400 validation error when address parameter is invalid Stellar key format', async () => {
      const res = await request(app).get(`/api/privacy/consent/${INVALID_ADDRESS}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('address');
    });

    it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff headers', async () => {
      const res = await request(app).get(`/api/privacy/consent/${VALID_ADDRESS}`);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns 405 Method Not Allowed with Allow header for unsupported HTTP verbs', async () => {
      const resPost = await request(app).post(`/api/privacy/consent/${VALID_ADDRESS}`).send({});
      expect(resPost.status).toBe(405);
      expect(resPost.headers['allow']).toBe('GET, HEAD');
      expect(resPost.body.error.code).toBe('METHOD_NOT_ALLOWED');

      const resDelete = await request(app).delete(`/api/privacy/consent/${VALID_ADDRESS}`);
      expect(resDelete.status).toBe(405);
      expect(resDelete.headers['allow']).toBe('GET, HEAD');
    });
  });

  // ── Database and Service Error Handling ────────────────────────────────────

  describe('Error Handling and Service Resilience', () => {
    it('returns 503 SERVICE_UNAVAILABLE when database pool is exhausted on PUT', async () => {
      mockQuery.mockRejectedValueOnce(new PoolExhaustedError());

      const payload = {
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: false,
      };

      const res = await request(app).put('/api/privacy/consent').send(payload);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.message).toContain('temporarily unavailable');
    });

    it('returns 503 SERVICE_UNAVAILABLE when database pool is exhausted on GET', async () => {
      mockQuery.mockRejectedValueOnce(new PoolExhaustedError());

      const res = await request(app).get(`/api/privacy/consent/${VALID_ADDRESS}`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.message).toContain('temporarily unavailable');
    });

    it('returns 503 SERVICE_UNAVAILABLE when pgcryptoKey is missing in app configuration', async () => {
      const baseConfig = loadConfig();
      const appWithoutKey = createApp({ config: { ...baseConfig, pgcryptoKey: '' } });

      const payload = {
        address: VALID_ADDRESS,
        analytics_optout: true,
        marketing_optout: false,
        biometric_processing_consent: false,
      };

      const res = await request(appWithoutKey).put('/api/privacy/consent').send(payload);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });
});
