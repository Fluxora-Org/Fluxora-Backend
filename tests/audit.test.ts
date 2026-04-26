/**
 * Audit log tests
 *
 * Covers:
 * - recordAuditEvent appends entries with correct shape
 * - GET /api/audit returns all entries
 * - Entries are created for STREAM_CREATED and STREAM_CANCELLED actions
 * - Entries are created for admin actions (PAUSE_FLAGS_UPDATED, REINDEX_TRIGGERED)
 * - Audit recording never throws (resilience)
 * - correlationId is propagated into audit entries
 * - Admin auth failures do not produce audit entries
 * - Validation failures do not produce audit entries
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { recordAuditEvent, getAuditEntries, _resetAuditLog } from '../src/lib/auditLog.js';
import { auditRouter } from '../src/routes/audit.js';
import { adminRouter } from '../src/routes/admin.js';
import { streamsRouter, streams, resetStreamIdempotencyStore } from '../src/routes/streams.js';
import { _resetForTest as resetAdminState } from '../src/state/adminState.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupertestApp = any;

const ADMIN_KEY = 'test-admin-key-for-audit-tests';

function createTestApp(): SupertestApp {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/streams', streamsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

let savedAdminKey: string | undefined;

beforeEach(() => {
  _resetAuditLog();
  resetAdminState();
  streams.length = 0;
  resetStreamIdempotencyStore();
  savedAdminKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterEach(() => {
  if (savedAdminKey !== undefined) {
    process.env.ADMIN_API_KEY = savedAdminKey;
  } else {
    delete process.env.ADMIN_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// Unit: recordAuditEvent
// ---------------------------------------------------------------------------

describe('recordAuditEvent', () => {
  it('appends an entry with required fields', () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 'stream-1');
    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.seq).toBe(1);
    expect(e.action).toBe('STREAM_CREATED');
    expect(e.resourceType).toBe('stream');
    expect(e.resourceId).toBe('stream-1');
    expect(typeof e.timestamp).toBe('string');
  });

  it('increments seq monotonically', () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 'a');
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'b');
    const entries = getAuditEntries();
    expect(entries[0]!.seq).toBe(1);
    expect(entries[1]!.seq).toBe(2);
  });

  it('stores correlationId and meta when provided', () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 'x', 'corr-123', { depositAmount: '100' });
    const [e] = getAuditEntries();
    expect(e.correlationId).toBe('corr-123');
    expect(e.meta?.depositAmount).toBe('100');
  });

  it('omits correlationId key when not provided', () => {
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'y');
    const [e] = getAuditEntries();
    expect(Object.prototype.hasOwnProperty.call(e, 'correlationId')).toBe(false);
  });

  it('does not throw when called multiple times', () => {
    expect(() => {
      for (let i = 0; i < 5; i++) {
        recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`);
      }
    }).not.toThrow();
    expect(getAuditEntries()).toHaveLength(5);
  });

  it('records PAUSE_FLAGS_UPDATED with meta', () => {
    recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system', 'c-1', {
      streamCreation: true,
    });
    const [e] = getAuditEntries();
    expect(e.action).toBe('PAUSE_FLAGS_UPDATED');
    expect(e.resourceType).toBe('pauseFlags');
    expect(e.meta?.streamCreation).toBe(true);
  });

  it('records REINDEX_TRIGGERED with meta', () => {
    recordAuditEvent('REINDEX_TRIGGERED', 'reindex', 'system', undefined, {
      status: 'running',
    });
    const [e] = getAuditEntries();
    expect(e.action).toBe('REINDEX_TRIGGERED');
    expect(e.meta?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Unit: getAuditEntries returns a copy
// ---------------------------------------------------------------------------

describe('getAuditEntries', () => {
  it('returns a copy — mutations do not affect the store', () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    const copy = getAuditEntries();
    copy.pop();
    expect(getAuditEntries()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: GET /api/audit
// ---------------------------------------------------------------------------

describe('GET /api/audit', () => {
  let app: SupertestApp;

  beforeEach(() => {
    app = createTestApp();
  });

  it('returns 200 with empty entries when log is empty', async () => {
    const res = await request(app).get('/api/audit').expect(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('returns all recorded entries', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 'abc');
    recordAuditEvent('STREAM_CANCELLED', 'stream', 'abc');
    const res = await request(app).get('/api/audit').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.entries[0].action).toBe('STREAM_CREATED');
    expect(res.body.entries[1].action).toBe('STREAM_CANCELLED');
  });

  it('includes admin audit entries alongside stream entries', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system');
    recordAuditEvent('REINDEX_TRIGGERED', 'reindex', 'system');
    const res = await request(app).get('/api/audit').expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.entries.map((e: any) => e.action)).toEqual([
      'STREAM_CREATED',
      'PAUSE_FLAGS_UPDATED',
      'REINDEX_TRIGGERED',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration: audit entries created by stream operations
// ---------------------------------------------------------------------------

describe('Audit entries via streams API', () => {
  let app: SupertestApp;

  beforeEach(() => {
    app = createTestApp();
  });

  const validStream = {
    sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
    recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
    depositAmount: '1000.0000000',
    ratePerSecond: '0.0000116',
  };

  it('records STREAM_CREATED when a stream is created', async () => {
    await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', 'audit-test-create-1')
      .send(validStream)
      .expect(201);
    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('STREAM_CREATED');
    expect(entries[0]!.resourceType).toBe('stream');
    expect(entries[0]!.meta?.depositAmount).toBe('1000.0000000');
  });

  it('records STREAM_CANCELLED when a stream is cancelled', async () => {
    const createRes = await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', 'audit-test-cancel-1')
      .send(validStream)
      .expect(201);
    const { id } = createRes.body;

    await request(app).delete(`/api/streams/${id}`).expect(200);

    const entries = getAuditEntries();
    const cancelEntry = entries.find((e) => e.action === 'STREAM_CANCELLED');
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry?.resourceId).toBe(id);
  });

  it('propagates correlationId from request into audit entry', async () => {
    await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', 'audit-test-corr-1')
      .set('x-correlation-id', 'test-corr-999')
      .send(validStream)
      .expect(201);

    const [entry] = getAuditEntries();
    expect(entry.correlationId).toBe('test-corr-999');
  });

  it('does not record an audit entry when stream creation fails validation', async () => {
    await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', 'audit-test-invalid-1')
      .send({ ...validStream, depositAmount: 9999 }) // number, not string
      .expect(400);

    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record an audit entry when cancelling a non-existent stream', async () => {
    await request(app).delete('/api/streams/does-not-exist').expect(404);
    expect(getAuditEntries()).toHaveLength(0);
  });

  it('includes sender and recipient in STREAM_CREATED meta', async () => {
    await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', 'audit-test-meta-1')
      .send(validStream)
      .expect(201);

    const [entry] = getAuditEntries();
    expect(entry.meta?.sender).toBe(validStream.sender);
    expect(entry.meta?.recipient).toBe(validStream.recipient);
    expect(entry.meta?.ratePerSecond).toBe(validStream.ratePerSecond);
  });
});

// ---------------------------------------------------------------------------
// Integration: audit entries created by admin operations
// ---------------------------------------------------------------------------

describe('Audit entries via admin API', () => {
  let app: SupertestApp;

  beforeEach(() => {
    app = createTestApp();
  });

  function adminRequest(method: 'get' | 'put' | 'post', path: string) {
    return (request(app) as any)[method](`/api/admin${path}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
  }

  // -- PUT /api/admin/pause --------------------------------------------------

  it('records PAUSE_FLAGS_UPDATED when pause flags are changed', async () => {
    await adminRequest('put', '/pause')
      .send({ streamCreation: true })
      .expect(200);

    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.action).toBe('PAUSE_FLAGS_UPDATED');
    expect(entry.resourceType).toBe('pauseFlags');
    expect(entry.resourceId).toBe('system');
    expect(entry.meta?.streamCreation).toBe(true);
    expect(entry.meta?.updated).toEqual({ streamCreation: true, ingestion: false });
  });

  it('captures previous and updated state in PAUSE_FLAGS_UPDATED meta', async () => {
    await adminRequest('put', '/pause')
      .send({ streamCreation: true, ingestion: true })
      .expect(200);

    const [entry] = getAuditEntries();
    expect(entry.meta?.previous).toEqual({ streamCreation: false, ingestion: false });
    expect(entry.meta?.updated).toEqual({ streamCreation: true, ingestion: true });
  });

  it('does not record audit when pause validation fails (empty body)', async () => {
    await adminRequest('put', '/pause')
      .send({})
      .expect(400);

    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record audit when pause validation fails (bad types)', async () => {
    await adminRequest('put', '/pause')
      .send({ streamCreation: 'yes' })
      .expect(400);

    expect(getAuditEntries()).toHaveLength(0);
  });

  it('propagates correlationId into admin audit entry', async () => {
    await adminRequest('put', '/pause')
      .set('x-correlation-id', 'admin-corr-456')
      .send({ ingestion: true })
      .expect(200);

    const [entry] = getAuditEntries();
    expect(entry.correlationId).toBe('admin-corr-456');
  });

  // -- POST /api/admin/reindex -----------------------------------------------

  it('records REINDEX_TRIGGERED when a reindex is started', async () => {
    await adminRequest('post', '/reindex').expect(202);

    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.action).toBe('REINDEX_TRIGGERED');
    expect(entry.resourceType).toBe('reindex');
    expect(entry.resourceId).toBe('system');
    expect(entry.meta?.status).toBe('running');
    expect(typeof entry.meta?.startedAt).toBe('string');
  });

  it('does not record audit when reindex is already running (409)', async () => {
    await adminRequest('post', '/reindex').expect(202);
    _resetAuditLog();

    await adminRequest('post', '/reindex').expect(409);

    expect(getAuditEntries()).toHaveLength(0);
  });

  // -- Auth boundary: unauthenticated requests never produce entries ----------

  it('does not record audit when admin auth is missing', async () => {
    await request(app)
      .put('/api/admin/pause')
      .send({ streamCreation: true })
      .expect(401);

    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record audit when admin credentials are wrong', async () => {
    await request(app)
      .put('/api/admin/pause')
      .set('Authorization', 'Bearer wrong-key-value-here')
      .send({ streamCreation: true })
      .expect(403);

    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record audit when ADMIN_API_KEY is not configured', async () => {
    delete process.env.ADMIN_API_KEY;

    await request(app)
      .put('/api/admin/pause')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ streamCreation: true })
      .expect(503);

    expect(getAuditEntries()).toHaveLength(0);
  });

  // -- Read-only admin endpoints do not produce audit entries -----------------

  it('does not record audit for GET /api/admin/status', async () => {
    await adminRequest('get', '/status').expect(200);
    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record audit for GET /api/admin/pause', async () => {
    await adminRequest('get', '/pause').expect(200);
    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record audit for GET /api/admin/reindex', async () => {
    await adminRequest('get', '/reindex').expect(200);
    expect(getAuditEntries()).toHaveLength(0);
  });
});
