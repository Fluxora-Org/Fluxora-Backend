/**
 * Audit log tests
 *
 * Covers:
 * - recordAuditEvent appends entries with correct shape
 * - GET /api/audit returns all entries
 * - Entries are created for STREAM_CREATED and STREAM_CANCELLED actions
 * - Audit recording never throws (resilience)
 * - correlationId is propagated into audit entries
 */

import express, { Application } from 'express';
import request from 'supertest';
import { recordAuditEvent, getAuditEntries, _resetAuditLog } from '../src/lib/auditLog.js';
import { auditRouter } from '../src/routes/audit.js';
import { streamsRouter } from '../src/routes/streams.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { generateToken } from '../src/lib/auth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupertestApp = any;

function createTestApp(): SupertestApp {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/streams', streamsRouter);
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  _resetAuditLog();
});

// ---------------------------------------------------------------------------
// Unit: recordAuditEvent
// ---------------------------------------------------------------------------

describe('recordAuditEvent', () => {
  it('appends an entry with required fields', () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 'stream-1');
    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e!.seq).toBe(1);
    expect(e!.action).toBe('STREAM_CREATED');
    expect(e!.resourceType).toBe('stream');
    expect(e!.resourceId).toBe('stream-1');
    expect(typeof e!.timestamp).toBe('string');
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
    expect(e!.correlationId).toBe('corr-123');
    expect(e!.meta?.depositAmount).toBe('100');
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
});

// ---------------------------------------------------------------------------
// Integration: audit entries created by stream operations
// ---------------------------------------------------------------------------

describe('Audit entries via streams API', () => {
  let app: SupertestApp;
  let token: string;

  beforeEach(() => {
    app = createTestApp();
    token = generateToken({ address: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX', role: 'operator' });
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
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'audit-create-1')
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
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'audit-cancel-1')
      .send(validStream)
      .expect(201);
    const { id } = createRes.body;

    await request(app)
      .delete(`/api/streams/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const entries = getAuditEntries();
    const cancelEntry = entries.find((e) => e.action === 'STREAM_CANCELLED');
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry?.resourceId).toBe(id);
  });

  it('propagates correlationId from request into audit entry', async () => {
    await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'audit-corr-1')
      .set('x-correlation-id', 'test-corr-999')
      .send(validStream)
      .expect(201);

    const [entry] = getAuditEntries();
    expect(entry!.correlationId).toBe('test-corr-999');
  });

  it('does not record an audit entry when stream creation fails validation', async () => {
    await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validStream, depositAmount: 9999 }) // number, not string
      .expect(400);

    expect(getAuditEntries()).toHaveLength(0);
  });

  it('does not record an audit entry when cancelling a non-existent stream', async () => {
    await request(app)
      .delete('/api/streams/does-not-exist')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(getAuditEntries()).toHaveLength(0);
  });
});
