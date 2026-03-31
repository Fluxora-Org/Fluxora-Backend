import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { DataClassification, RETENTION_SCHEDULE, TRUST_BOUNDARIES } from '../../src/pii/policy.js';

const app = createApp();

describe('GET /api/privacy/policy', () => {
  it('returns 200 with the full PII policy document', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('fluxora-backend');
    expect(res.body.piiPolicy).toBeDefined();
  });

  it('includes a human-readable summary', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const summary: string = res.body.piiPolicy.summary;
    expect(summary).toContain('Stellar public keys');
    expect(summary).toContain('No direct PII');
  });

  it('lists all data classification levels', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const levels = res.body.piiPolicy.dataClassifications.map(
      (d: { level: string }) => d.level,
    );
    expect(levels).toContain(DataClassification.PUBLIC);
    expect(levels).toContain(DataClassification.INTERNAL);
    expect(levels).toContain(DataClassification.SENSITIVE);
    expect(levels).toContain(DataClassification.RESTRICTED);
  });

  it('includes field policies for stream and request data', async () => {
    const res = await request(app).get('/api/privacy/policy');
    const fp = res.body.piiPolicy.fieldPolicies;
    expect(fp.streamFields).toBeDefined();
    expect(fp.requestFields).toBeDefined();
    expect(fp.streamFields.sender.classification).toBe(DataClassification.SENSITIVE);
  });

  it('includes the retention schedule', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.body.piiPolicy.retentionSchedule.length).toBe(RETENTION_SCHEDULE.length);
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

  it('includes HATEOAS _links', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.body._links.self).toBe('/api/privacy/policy');
    expect(res.body._links.health).toBe('/health');
  });
});

describe('GET /api/privacy/retention', () => {
  it('returns 200 with the retention schedule', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.status).toBe(200);
    expect(res.body.retentionSchedule).toBeDefined();
    expect(res.body.retentionSchedule.length).toBe(RETENTION_SCHEDULE.length);
  });

  it('does not expose field policies or trust boundaries', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.body.fieldPolicies).toBeUndefined();
    expect(res.body.trustBoundaries).toBeUndefined();
  });
});
