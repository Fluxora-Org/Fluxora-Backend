import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  DataClassification,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
} from '../../src/pii/policy.js';

const app = createApp();

// ── Shared helpers ──────────────────────────────────────────────

const UNSUPPORTED_METHODS = ['post', 'put', 'patch', 'delete'] as const;

// ── GET /api/privacy/policy ─────────────────────────────────────

describe('GET /api/privacy/policy', () => {
  it('returns 200 with the full PII policy document', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('fluxora-backend');
    expect(res.body.version).toBe('0.1.0');
    expect(res.body.piiPolicy).toBeDefined();
  });

  it('responds with application/json content type', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('sets Cache-Control: no-store to prevent intermediary caching', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('includes a human-readable summary mentioning Stellar keys and no direct PII', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const summary: string = res.body.piiPolicy.summary;
    expect(summary).toContain('Stellar public keys');
    expect(summary).toContain('No direct PII');
    expect(summary).toContain('ephemeral');
  });

  it('lists all four data classification levels with descriptions', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const classifications: { level: string; description: string }[] =
      res.body.piiPolicy.dataClassifications;

    const levels = classifications.map((d) => d.level);
    expect(levels).toContain(DataClassification.PUBLIC);
    expect(levels).toContain(DataClassification.INTERNAL);
    expect(levels).toContain(DataClassification.SENSITIVE);
    expect(levels).toContain(DataClassification.RESTRICTED);

    for (const entry of classifications) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('includes field policies for stream and request data', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const fp = res.body.piiPolicy.fieldPolicies;
    expect(fp.streamFields).toBeDefined();
    expect(fp.requestFields).toBeDefined();
  });

  it('marks sender and recipient as SENSITIVE with redactInLogs', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const stream = res.body.piiPolicy.fieldPolicies.streamFields;
    expect(stream.sender.classification).toBe(DataClassification.SENSITIVE);
    expect(stream.sender.redactInLogs).toBe(true);
    expect(stream.recipient.classification).toBe(DataClassification.SENSITIVE);
    expect(stream.recipient.redactInLogs).toBe(true);
  });

  it('exposes every stream field defined in the policy module', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const stream = res.body.piiPolicy.fieldPolicies.streamFields;
    for (const fieldName of Object.keys(STREAM_FIELD_POLICIES)) {
      expect(stream).toHaveProperty(fieldName);
    }
  });

  it('exposes every request field defined in the policy module', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const reqFields = res.body.piiPolicy.fieldPolicies.requestFields;
    for (const fieldName of Object.keys(REQUEST_FIELD_POLICIES)) {
      expect(reqFields).toHaveProperty(fieldName);
    }
  });

  it('marks ipAddress and authToken as RESTRICTED', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const reqFields = res.body.piiPolicy.fieldPolicies.requestFields;
    expect(reqFields.ipAddress.classification).toBe(DataClassification.RESTRICTED);
    expect(reqFields.authToken.classification).toBe(DataClassification.RESTRICTED);
  });

  it('includes the retention schedule matching the policy module length', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.body.piiPolicy.retentionSchedule).toHaveLength(RETENTION_SCHEDULE.length);
  });

  it('each retention rule has category, retentionDays, storageLayer, and rationale', async () => {
    const res = await request(app).get('/api/privacy/policy');
    for (const rule of res.body.piiPolicy.retentionSchedule) {
      expect(rule).toHaveProperty('category');
      expect(rule).toHaveProperty('retentionDays');
      expect(rule).toHaveProperty('storageLayer');
      expect(rule).toHaveProperty('rationale');
    }
  });

  it('includes trust boundaries for all actor classes', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const actors = res.body.piiPolicy.trustBoundaries.map(
      (b: { actor: string }) => b.actor,
    );
    for (const boundary of TRUST_BOUNDARIES) {
      expect(actors).toContain(boundary.actor);
    }
  });

  it('each trust boundary has non-empty allowed and denied lists', async () => {
    const res = await request(app).get('/api/privacy/policy');
    for (const boundary of res.body.piiPolicy.trustBoundaries) {
      expect(Array.isArray(boundary.allowed)).toBe(true);
      expect(boundary.allowed.length).toBeGreaterThan(0);
      expect(Array.isArray(boundary.denied)).toBe(true);
      expect(boundary.denied.length).toBeGreaterThan(0);
    }
  });

  it('includes HATEOAS _links with self, retention, health, and streams', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.body._links.self).toBe('/api/privacy/policy');
    expect(res.body._links.retention).toBe('/api/privacy/retention');
    expect(res.body._links.health).toBe('/health');
    expect(res.body._links.streams).toBe('/api/streams');
  });

  it('HEAD request returns 200 with no body', async () => {
    const res = await request(app).head('/api/privacy/policy');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({});
  });

  it.each(UNSUPPORTED_METHODS)('%s returns 405 with Allow header', async (method) => {
    const res = await (request(app) as any)[method]('/api/privacy/policy');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

// ── GET /api/privacy/retention ──────────────────────────────────

describe('GET /api/privacy/retention', () => {
  it('returns 200 with the retention schedule', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.status).toBe(200);
    expect(res.body.retentionSchedule).toBeDefined();
    expect(res.body.retentionSchedule).toHaveLength(RETENTION_SCHEDULE.length);
  });

  it('responds with application/json content type', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('sets Cache-Control: no-store', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not expose field policies or trust boundaries', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.body.fieldPolicies).toBeUndefined();
    expect(res.body.trustBoundaries).toBeUndefined();
    expect(res.body.piiPolicy).toBeUndefined();
  });

  it('each retention rule has the expected shape', async () => {
    const res = await request(app).get('/api/privacy/retention');
    for (const rule of res.body.retentionSchedule) {
      expect(typeof rule.category).toBe('string');
      expect(typeof rule.storageLayer).toBe('string');
      expect(typeof rule.rationale).toBe('string');
      expect(
        rule.retentionDays === null || typeof rule.retentionDays === 'number',
      ).toBe(true);
    }
  });

  it('includes HATEOAS _links with self and fullPolicy', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.body._links.self).toBe('/api/privacy/retention');
    expect(res.body._links.fullPolicy).toBe('/api/privacy/policy');
  });

  it('HEAD request returns 200 with no body', async () => {
    const res = await request(app).head('/api/privacy/retention');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it.each(UNSUPPORTED_METHODS)('%s returns 405 with Allow header', async (method) => {
    const res = await (request(app) as any)[method]('/api/privacy/retention');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

// ── Unknown sub-route ───────────────────────────────────────────

describe('unknown /api/privacy sub-routes', () => {
  it('GET /api/privacy/unknown returns 404', async () => {
    const res = await request(app).get('/api/privacy/unknown');
    expect(res.status).toBe(404);
  });

  it('GET /api/privacy (no trailing path) returns 404', async () => {
    const res = await request(app).get('/api/privacy');
    expect(res.status).toBe(404);
  });
});
