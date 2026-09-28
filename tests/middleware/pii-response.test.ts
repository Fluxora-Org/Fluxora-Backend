import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sanitizeResponses } from '../../src/middleware/pii.js';
import { STREAM_FIELD_POLICIES, REQUEST_FIELD_POLICIES } from '../../src/pii/policy.js';
import { REDACTED } from '../../src/pii/sanitizer.js';
import { ApiError, ApiErrorCode, errorHandler } from '../../src/middleware/errorHandler.js';

describe('PII response middleware', () => {
  describe('sanitizeResponses', () => {
    const policyFields = Object.entries({ ...STREAM_FIELD_POLICIES, ...REQUEST_FIELD_POLICIES })
      .filter(([, policy]) => policy.redactInLogs)
      .map(([field]) => field);
    const sensitive = Object.fromEntries(
      policyFields.map((field) => [field, `sensitive-value-${field}-END`])
    );

    it('redacts every policy field in a JSON response without changing public fields', async () => {
      const responseApp = express();
      responseApp.use(sanitizeResponses);
      responseApp.get('/response', (_req, res) => {
        res.json({ data: sensitive, nested: [sensitive], id: 'public-id' });
      });

      const res = await request(responseApp).get('/response');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('public-id');
      for (const field of policyFields) {
        expect(res.body.data[field], field).toBe(REDACTED);
        expect(res.body.nested[0][field], field).toBe(REDACTED);
        expect(res.text).not.toContain(`sensitive-value-${field}-END`);
      }
    });

    it('also redacts a directly sent JSON string', async () => {
      const responseApp = express();
      responseApp.use(sanitizeResponses);
      responseApp.get('/response', (_req, res) => {
        res.type('application/json').send(JSON.stringify({ secret: 'private-value' }));
      });

      const res = await request(responseApp).get('/response');
      expect(res.body.secret).toBe(REDACTED);
    });

    it('redacts policy fields in an exposed error response', async () => {
      const errorApp = express();
      errorApp.use(sanitizeResponses);
      errorApp.get('/error', () => {
        throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, 'Invalid request', sensitive, true);
      });
      errorApp.use(errorHandler);

      const res = await request(errorApp).get('/error');
      expect(res.status).toBe(400);
      for (const field of policyFields) {
        expect(res.body.error.details[field], field).toBe(REDACTED);
        expect(res.text).not.toContain(`sensitive-value-${field}-END`);
      }
    });

    it('preserves only the documented session token and address', async () => {
      const authApp = express();
      authApp.use(sanitizeResponses);
      authApp.post('/api/auth/session', (_req, res) => {
        res.json({
          token: 'issued-token',
          user: { address: 'GAUTH', role: 'viewer' },
          secret: 'private',
        });
      });

      const res = await request(authApp).post('/api/auth/session');
      expect(res.body.token).toBe('issued-token');
      expect(res.body.user.address).toBe('GAUTH');
      expect(res.body.secret).toBe(REDACTED);
    });

    it('preserves the public policy document metadata', async () => {
      const policyApp = express();
      policyApp.use(sanitizeResponses);
      policyApp.get('/api/privacy/policy', (_req, res) => {
        res.json({ fieldPolicies: { password: { classification: 'RESTRICTED' } } });
      });

      const res = await request(policyApp).get('/api/privacy/policy');
      expect(res.body.fieldPolicies.password.classification).toBe('RESTRICTED');
    });
  });
});
