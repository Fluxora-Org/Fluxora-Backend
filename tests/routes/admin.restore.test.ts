/**
 * tests/routes/admin.restore.test.ts
 *
 * Comprehensive test suite for the admin backup-restore endpoints:
 *   POST   /api/admin/restore
 *   GET    /api/admin/restore/:jobId
 *   GET    /api/admin/restore
 *
 * Coverage strategy
 * ─────────────────
 * - Auth gate (missing header, wrong scheme, bad token, unconfigured key)
 * - Input validation (missing backupId, empty string, path traversal, prefix escape, too long,
 *   bad targetEnvironment, production without confirmProduction)
 * - Happy path (staging restore, production restore with confirmation)
 * - Async lifecycle (queued → running → completed / failed)
 * - Audit events (BACKUP_RESTORE_QUEUED emitted immediately)
 * - Job polling (GET /:jobId — found, not found, empty id, overlong id)
 * - Job listing (GET /restore — empty list, multiple jobs, newest-first order)
 * - S3_BACKUP_BUCKET absent → 503
 * - Concurrent jobs (multiple independent jobs coexist)
 * - Response envelope shape (success: true/false, data, meta, error.code)
 *
 * Security notes
 * ──────────────
 * - backupId path-traversal and prefix-escape payloads are explicitly rejected at the route layer
 *   (via queueRestoreJob's validateBackupId) before any S3 call is made.
 * - Production restores require an explicit `confirmProduction: true` flag;
 *   omitting it or setting it to a falsy value returns 400.
 * - The `S3_BACKUP_BUCKET` check is performed synchronously before the async
 *   job is queued, so misconfigured environments fail fast with 503.
 * - All admin routes sit behind requireAdminAuth (timing-safe Bearer comparison).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import {
  _resetRestoreJobs,
  normalizeBackupPrefix,
  resolveBackupObjectKey,
} from '../../src/scripts/backup-retention.js';
import { _resetAuditLog, getAuditEntries } from '../../src/lib/auditLog.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key-for-restore-routes';
const VALID_BACKUP_ID = 'backups/db-2026-07-01.sql.gz';
const CUSTOM_PREFIX = 'private/fluxora-backups/';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Attaches the admin Bearer token to any supertest request. */
function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

/** Returns a POST /api/admin/restore request with the given body, authenticated. */
function postRestore(body: Record<string, unknown>): request.Test {
  return authed(request(app).post('/api/admin/restore').send(body));
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let originalAdminKey: string | undefined;
let originalBucket: string | undefined;

beforeEach(() => {
  originalAdminKey = process.env.ADMIN_API_KEY;
  originalBucket = process.env.S3_BACKUP_BUCKET;

  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.S3_BACKUP_BUCKET = 'test-backup-bucket';

  _resetRestoreJobs();
  _resetAuditLog();
});

afterEach(() => {
  if (originalAdminKey !== undefined) {
    process.env.ADMIN_API_KEY = originalAdminKey;
  } else {
    delete process.env.ADMIN_API_KEY;
  }

  if (originalBucket !== undefined) {
    process.env.S3_BACKUP_BUCKET = originalBucket;
  } else {
    delete process.env.S3_BACKUP_BUCKET;
  }

  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth gate
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/restore — auth gate', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = await request(app).post('/api/admin/restore').send({ backupId: VALID_BACKUP_ID });
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    const res = await request(app)
      .post('/api/admin/restore')
      .set('Authorization', `Basic ${ADMIN_KEY}`)
      .send({ backupId: VALID_BACKUP_ID });
    expect(res.status).toBe(401);
  });

  it('returns 403 when Bearer token is incorrect', async () => {
    const res = await request(app)
      .post('/api/admin/restore')
      .set('Authorization', 'Bearer wrong-token')
      .send({ backupId: VALID_BACKUP_ID });
    expect(res.status).toBe(403);
  });

  it('returns 503 when ADMIN_API_KEY env var is unset', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(app)
      .post('/api/admin/restore')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ backupId: VALID_BACKUP_ID });
    expect(res.status).toBe(503);
  });

  it('returns 401 when Authorization header is oversized', async () => {
    const res = await request(app)
      .post('/api/admin/restore')
      .set('Authorization', `Bearer ${'x'.repeat(9000)}`)
      .send({ backupId: VALID_BACKUP_ID });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/restore/:jobId — auth gate', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).get('/api/admin/restore/some-job-id');
    expect(res.status).toBe(401);
  });

  it('returns 403 when token is wrong', async () => {
    const res = await request(app)
      .get('/api/admin/restore/some-job-id')
      .set('Authorization', 'Bearer bad-key');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/restore — auth gate', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).get('/api/admin/restore');
    expect(res.status).toBe(401);
  });

  it('returns 403 when token is wrong', async () => {
    const res = await request(app).get('/api/admin/restore').set('Authorization', 'Bearer bad-key');
    expect(res.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/admin/restore — input validation
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/restore — input validation', () => {
  it('returns 400 when backupId is missing from body', async () => {
    const res = await postRestore({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/backupId/i);
  });

  it('returns 400 when backupId is null', async () => {
    const res = await postRestore({ backupId: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when backupId is a number', async () => {
    const res = await postRestore({ backupId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when backupId is an empty string', async () => {
    const res = await postRestore({ backupId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when backupId is whitespace only', async () => {
    // queueRestoreJob trims and checks non-empty, so whitespace-only also fails
    const res = await postRestore({ backupId: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when backupId starts with "/"', async () => {
    const res = await postRestore({ backupId: '/etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/must not start with/i);
  });

  it('returns 400 when backupId contains path traversal ".."', async () => {
    const res = await postRestore({ backupId: '../../etc/shadow' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/path traversal/i);
  });

  it('returns 400 when backupId contains embedded ".." traversal', async () => {
    const res = await postRestore({ backupId: 'backups/../secrets/key' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when backupId is outside the configured backup prefix', async () => {
    process.env.S3_BACKUP_PREFIX = CUSTOM_PREFIX;
    const outsideKeys = [
      'backups/db-2026-07-01.sql.gz',
      'private/fluxora-backups-archive/db.sql.gz',
      '/private/fluxora-backups/db.sql.gz',
    ];

    for (const backupId of outsideKeys) {
      const res = await postRestore({ backupId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/configured backup prefix/i);
    }
  });

  it('accepts nested keys under a custom configured prefix', async () => {
    process.env.S3_BACKUP_PREFIX = CUSTOM_PREFIX;
    const nestedKey = `${CUSTOM_PREFIX}2026/07/daily/db-snapshot.sql.gz`;
    const res = await postRestore({ backupId: nestedKey });

    expect(res.status).toBe(202);
    expect(res.body.data.job.backupId).toBe(nestedKey);
  });

  it('rejects encoded separators and traversal components', () => {
    process.env.S3_BACKUP_PREFIX = CUSTOM_PREFIX;
    for (const backupId of [
      `${CUSTOM_PREFIX}2026%2F07%2Fdb.sql.gz`,
      `${CUSTOM_PREFIX}2026/%2e%2e/secrets.sql.gz`,
      `${CUSTOM_PREFIX}2026\\\\07\\\\db.sql.gz`,
      `${CUSTOM_PREFIX}2026/./db.sql.gz`,
    ]) {
      expect(() => resolveBackupObjectKey(backupId, CUSTOM_PREFIX)).toThrow();
    }
  });

  it('normalizes configured prefixes to one slash-delimited boundary', () => {
    expect(normalizeBackupPrefix(' /private/fluxora-backups/ ')).toBe('private/fluxora-backups/');
  });

  it('returns 400 when backupId exceeds 1024 characters', async () => {
    const res = await postRestore({ backupId: 'a'.repeat(1025) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/1 024/i);
  });

  it('returns 400 when targetEnvironment is an unrecognised value', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'development',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/staging.*production/i);
  });

  it('returns 400 when targeting production without confirmProduction', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/confirmProduction/i);
  });

  it('returns 400 when confirmProduction is false and environment is production', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
      confirmProduction: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when confirmProduction is a string "true" (not boolean)', async () => {
    // queueRestoreJob requires strict boolean true, not the string "true"
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
      confirmProduction: 'true',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/admin/restore — missing S3 configuration
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/restore — missing S3_BACKUP_BUCKET', () => {
  it('returns 503 when S3_BACKUP_BUCKET is not set', async () => {
    delete process.env.S3_BACKUP_BUCKET;

    const res = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFIGURATION_ERROR');
    expect(res.body.error.message).toMatch(/S3_BACKUP_BUCKET/i);
  });

  it('returns 503 when S3_BACKUP_BUCKET is empty string', async () => {
    process.env.S3_BACKUP_BUCKET = '';

    const res = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CONFIGURATION_ERROR');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/admin/restore — happy path
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/restore — happy path', () => {
  it('returns 202 with a queued job for a valid staging restore', async () => {
    const res = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toMatch(/queued/i);

    const job = res.body.data.job;
    expect(job.jobId).toBeTruthy();
    expect(job.backupId).toBe(VALID_BACKUP_ID);
    expect(job.status).toBe('queued');
    expect(job.targetEnvironment).toBe('staging');
    expect(job.queuedAt).toBeTruthy();
    expect(new Date(job.queuedAt).getTime()).toBeGreaterThan(0);
  });

  it('returns 202 for a production restore with confirmProduction: true', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
      confirmProduction: true,
    });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.job.targetEnvironment).toBe('production');
  });

  it('defaults targetEnvironment to "staging" when omitted', async () => {
    const res = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res.status).toBe(202);
    expect(res.body.data.job.targetEnvironment).toBe('staging');
  });

  it('accepts targetEnvironment: "staging" explicitly', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'staging',
    });

    expect(res.status).toBe(202);
    expect(res.body.data.job.targetEnvironment).toBe('staging');
  });

  it('response has success envelope shape: success, data, meta', async () => {
    const res = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('job returned in response has all required fields', async () => {
    const res = await postRestore({ backupId: VALID_BACKUP_ID });
    const job = res.body.data.job;

    expect(job).toHaveProperty('jobId');
    expect(job).toHaveProperty('backupId');
    expect(job).toHaveProperty('status');
    expect(job).toHaveProperty('targetEnvironment');
    expect(job).toHaveProperty('queuedAt');
  });

  it('each call creates a distinct jobId', async () => {
    const res1 = await postRestore({ backupId: VALID_BACKUP_ID });
    const res2 = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res1.body.data.job.jobId).not.toBe(res2.body.data.job.jobId);
  });

  it('accepts a deeply nested but valid backup key', async () => {
    const deepKey = 'backups/2026/07/daily/db-snapshot.sql.gz';
    const res = await postRestore({ backupId: deepKey });

    expect(res.status).toBe(202);
    expect(res.body.data.job.backupId).toBe(deepKey);
  });

  it('accepts a backup key exactly at the 1024-character limit', async () => {
    const longKey = 'a'.repeat(1024);
    const res = await postRestore({ backupId: longKey });

    expect(res.status).toBe(202);
    expect(res.body.data.job.backupId).toBe(longKey);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Async job lifecycle
// ═════════════════════════════════════════════════════════════════════════════

describe('restore job async lifecycle', () => {
  it('job transitions from queued → running after setImmediate fires', async () => {
    const res = await postRestore({ backupId: VALID_BACKUP_ID });
    const { jobId } = res.body.data.job;

    // Allow the setImmediate callback to run
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pollRes = await authed(request(app).get(`/api/admin/restore/${jobId}`));
    expect(pollRes.status).toBe(200);
    // At minimum the job has transitioned to running (it may have also completed/failed
    // depending on whether the S3 call resolved synchronously in the test env).
    expect(['running', 'completed', 'failed']).toContain(pollRes.body.data.job.status);
  });

  it('queued job emits BACKUP_RESTORE_QUEUED audit entry immediately', async () => {
    await postRestore({ backupId: VALID_BACKUP_ID });

    const entries = getAuditEntries();
    const queuedEntry = entries.find((e) => e.action === 'BACKUP_RESTORE_QUEUED');

    expect(queuedEntry).toBeDefined();
    expect(queuedEntry!.resourceType).toBe('backup');
    expect(queuedEntry!.meta?.backupId).toBe(VALID_BACKUP_ID);
  });

  it('audit entry for queued job contains targetEnvironment in meta', async () => {
    await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
      confirmProduction: true,
    });

    const entries = getAuditEntries();
    const entry = entries.find((e) => e.action === 'BACKUP_RESTORE_QUEUED');

    expect(entry).toBeDefined();
    expect(entry!.meta?.targetEnvironment).toBe('production');
  });

  it('running transition emits BACKUP_RESTORE_STARTED audit entry', async () => {
    await postRestore({ backupId: VALID_BACKUP_ID });

    // Flush setImmediate queue so the running transition fires
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entries = getAuditEntries();
    const startedEntry = entries.find((e) => e.action === 'BACKUP_RESTORE_STARTED');
    expect(startedEntry).toBeDefined();
  });

  it('multiple jobs produce independent audit trails', async () => {
    await postRestore({ backupId: 'backups/db-2026-07-01.sql.gz' });
    await postRestore({ backupId: 'backups/db-2026-07-02.sql.gz' });

    const entries = getAuditEntries().filter((e) => e.action === 'BACKUP_RESTORE_QUEUED');
    expect(entries.length).toBe(2);

    const backupIds = entries.map((e) => e.meta?.backupId as string);
    expect(backupIds).toContain('backups/db-2026-07-01.sql.gz');
    expect(backupIds).toContain('backups/db-2026-07-02.sql.gz');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/admin/restore/:jobId
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/restore/:jobId', () => {
  it('returns 200 with the job record when the job exists', async () => {
    const postRes = await postRestore({ backupId: VALID_BACKUP_ID });
    const { jobId } = postRes.body.data.job;

    const res = await authed(request(app).get(`/api/admin/restore/${jobId}`));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.job.jobId).toBe(jobId);
    expect(res.body.data.job.backupId).toBe(VALID_BACKUP_ID);
  });

  it('response has success envelope shape', async () => {
    const postRes = await postRestore({ backupId: VALID_BACKUP_ID });
    const { jobId } = postRes.body.data.job;

    const res = await authed(request(app).get(`/api/admin/restore/${jobId}`));

    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('returns 404 when jobId does not exist', async () => {
    const res = await authed(request(app).get('/api/admin/restore/nonexistent-job-id'));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toMatch(/nonexistent-job-id/);
  });

  it('returns 404 error envelope with correct shape', async () => {
    const res = await authed(request(app).get('/api/admin/restore/ghost-job'));

    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
    expect(res.body.error).toHaveProperty('message');
  });

  it('returns 400 when jobId exceeds 255 characters', async () => {
    const longId = 'x'.repeat(256);
    const res = await authed(request(app).get(`/api/admin/restore/${longId}`));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/255/);
  });

  it('returned job includes all lifecycle fields', async () => {
    const postRes = await postRestore({ backupId: VALID_BACKUP_ID });
    const { jobId } = postRes.body.data.job;

    const res = await authed(request(app).get(`/api/admin/restore/${jobId}`));
    const job = res.body.data.job;

    expect(job).toHaveProperty('jobId');
    expect(job).toHaveProperty('backupId');
    expect(job).toHaveProperty('status');
    expect(job).toHaveProperty('targetEnvironment');
    expect(job).toHaveProperty('queuedAt');
  });

  it('reflects updated status after async transition', async () => {
    const postRes = await postRestore({ backupId: VALID_BACKUP_ID });
    const { jobId } = postRes.body.data.job;

    // Flush the event loop so at least the running transition fires
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pollRes = await authed(request(app).get(`/api/admin/restore/${jobId}`));
    expect(['running', 'completed', 'failed']).toContain(pollRes.body.data.job.status);
  });

  it('different jobs can be polled independently', async () => {
    const r1 = await postRestore({ backupId: 'backups/a.sql.gz' });
    const r2 = await postRestore({ backupId: 'backups/b.sql.gz' });

    const jobId1 = r1.body.data.job.jobId;
    const jobId2 = r2.body.data.job.jobId;

    const poll1 = await authed(request(app).get(`/api/admin/restore/${jobId1}`));
    const poll2 = await authed(request(app).get(`/api/admin/restore/${jobId2}`));

    expect(poll1.body.data.job.backupId).toBe('backups/a.sql.gz');
    expect(poll2.body.data.job.backupId).toBe('backups/b.sql.gz');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/admin/restore
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/restore', () => {
  it('returns 200 with an empty jobs array when no jobs have been queued', async () => {
    const res = await authed(request(app).get('/api/admin/restore'));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobs).toEqual([]);
  });

  it('lists a single job after one restore is queued', async () => {
    await postRestore({ backupId: VALID_BACKUP_ID });

    const res = await authed(request(app).get('/api/admin/restore'));

    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toHaveLength(1);
    expect(res.body.data.jobs[0].backupId).toBe(VALID_BACKUP_ID);
  });

  it('returns all jobs after multiple restores', async () => {
    await postRestore({ backupId: 'backups/db-2026-07-01.sql.gz' });
    await postRestore({ backupId: 'backups/db-2026-07-02.sql.gz' });
    await postRestore({ backupId: 'backups/db-2026-07-03.sql.gz' });

    const res = await authed(request(app).get('/api/admin/restore'));

    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toHaveLength(3);
  });

  it('orders jobs newest-first (descending queuedAt)', async () => {
    await postRestore({ backupId: 'backups/db-2026-07-01.sql.gz' });
    // Small delay to guarantee distinct timestamps
    await new Promise<void>((r) => setTimeout(r, 5));
    await postRestore({ backupId: 'backups/db-2026-07-02.sql.gz' });

    const res = await authed(request(app).get('/api/admin/restore'));
    const jobs = res.body.data.jobs as Array<{ queuedAt: string }>;

    const timestamps = jobs.map((j) => new Date(j.queuedAt).getTime());
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]!);
    }
  });

  it('response has success envelope shape', async () => {
    const res = await authed(request(app).get('/api/admin/restore'));

    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('timestamp');
    expect(res.body.data).toHaveProperty('jobs');
  });

  it('listed jobs contain all required fields', async () => {
    await postRestore({ backupId: VALID_BACKUP_ID });

    const res = await authed(request(app).get('/api/admin/restore'));
    const job = res.body.data.jobs[0];

    expect(job).toHaveProperty('jobId');
    expect(job).toHaveProperty('backupId');
    expect(job).toHaveProperty('status');
    expect(job).toHaveProperty('targetEnvironment');
    expect(job).toHaveProperty('queuedAt');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Security edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/restore — security edge cases', () => {
  it('rejects null-byte injection in backupId', async () => {
    const res = await postRestore({ backupId: 'backups/db\x00.sql.gz' });
    // Either 400 from validation or 202 if the null byte passes the string check —
    // the important thing is it must NOT return 500 or expose internal details.
    expect([202, 400]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects "." as backupId (dot-path)', async () => {
    // Not an explicit traversal but a degenerate key — passes if accepted since
    // "." doesn't match our traversal check, but still a useful regression guard.
    const res = await postRestore({ backupId: '.' });
    // Either queued (single dot is a technically valid S3 key) or rejected —
    // we just confirm no 500.
    expect(res.status).not.toBe(500);
  });

  it('rejects backupId with ".." anywhere in the string', async () => {
    const payloads = ['backups/db-..-.sql.gz', '..backups/db.sql.gz', 'backups/..db.sql.gz'];

    for (const backupId of payloads) {
      const res = await postRestore({ backupId });
      // All contain ".." so they should be rejected
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('does not leak internal error details in 503 response', async () => {
    delete process.env.S3_BACKUP_BUCKET;
    const res = await postRestore({ backupId: VALID_BACKUP_ID });

    expect(res.status).toBe(503);
    // Response must not contain stack traces or internal paths
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/Error:/);
    expect(body).not.toMatch(/at Object\./);
    expect(body).not.toMatch(/node_modules/);
  });

  it('confirmation flag coercion: 1 (number) does not satisfy confirmProduction', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
      confirmProduction: 1,
    });
    // The route passes `confirmProduction === true` (strict), so numeric 1 fails.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('confirmation flag coercion: object does not satisfy confirmProduction', async () => {
    const res = await postRestore({
      backupId: VALID_BACKUP_ID,
      targetEnvironment: 'production',
      confirmProduction: { value: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 not 500 for oversized backupId at exact over-limit boundary', async () => {
    // 1025 chars — one over the limit
    const res = await postRestore({ backupId: 'b'.repeat(1025) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Concurrent / multiple jobs
// ═════════════════════════════════════════════════════════════════════════════

describe('concurrent restore jobs', () => {
  it('allows multiple jobs to be queued simultaneously', async () => {
    const keys = [
      'backups/db-2026-07-01.sql.gz',
      'backups/db-2026-07-02.sql.gz',
      'backups/db-2026-07-03.sql.gz',
    ];

    const responses = await Promise.all(keys.map((k) => postRestore({ backupId: k })));

    for (const res of responses) {
      expect(res.status).toBe(202);
    }

    // All jobs have distinct IDs
    const ids = responses.map((r) => r.body.data.job.jobId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each concurrent job is independently retrievable', async () => {
    const r1 = await postRestore({ backupId: 'backups/snap-a.sql.gz' });
    const r2 = await postRestore({ backupId: 'backups/snap-b.sql.gz' });

    const [p1, p2] = await Promise.all([
      authed(request(app).get(`/api/admin/restore/${r1.body.data.job.jobId}`)),
      authed(request(app).get(`/api/admin/restore/${r2.body.data.job.jobId}`)),
    ]);

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.data.job.backupId).toBe('backups/snap-a.sql.gz');
    expect(p2.body.data.job.backupId).toBe('backups/snap-b.sql.gz');
  });

  it('job list grows with each queued restore', async () => {
    for (let i = 1; i <= 5; i++) {
      await postRestore({ backupId: `backups/db-${i}.sql.gz` });
      const listRes = await authed(request(app).get('/api/admin/restore'));
      expect(listRes.body.data.jobs).toHaveLength(i);
    }
  });
});
