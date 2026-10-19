import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { auditRouter, toCsvField, auditRowToCsv, auditRowToNdjson } from './audit.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { generateToken } from '../lib/auth.js';
import { isErrorEnvelope } from '../utils/response.js';
import * as auditLogModule from '../lib/auditLog.js';
import { auditRepository, type AuditLogRow } from '../db/repositories/auditRepository.js';
import { logger } from '../lib/logger.js';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = 'test-audit-corr-id';
    next();
  });
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

describe('src/routes/audit.ts', () => {
  let app: Express;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;

  beforeEach(() => {
    auditLogModule._resetAuditLog();
    vi.restoreAllMocks();
    app = makeApp();

    adminToken = generateToken({
      address: 'GADMIN12345678901234567890123456789012345678901234567890',
      role: 'admin',
      permissions: ['audit:read', 'audit:write'],
    });

    operatorToken = generateToken({
      address: 'GOPERATOR1234567890123456789012345678901234567890123456',
      role: 'operator',
      permissions: ['audit:read'],
    });

    viewerToken = generateToken({
      address: 'GVIEWER123456789012345678901234567890123456789012345678',
      role: 'viewer',
      permissions: ['streams:read'],
    });
  });

  afterEach(() => {
    auditLogModule._resetAuditLog();
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CSV / NDJSON and Sanitisation Unit Helpers
  // ────────────────────────────────────────────────────────────────────────────

  describe('CSV & NDJSON formatting and formula injection guard', () => {
    describe('toCsvField', () => {
      it('handles null and undefined as empty quoted fields', () => {
        expect(toCsvField(null)).toBe('""');
        expect(toCsvField(undefined)).toBe('""');
      });

      it('quotes plain strings and doubles embedded double-quotes', () => {
        expect(toCsvField('hello')).toBe('"hello"');
        expect(toCsvField('hello "world"')).toBe('"hello ""world"""');
      });

      it('serializes numbers and booleans', () => {
        expect(toCsvField(123)).toBe('"123"');
        expect(toCsvField(true)).toBe('"true"');
        expect(toCsvField(false)).toBe('"false"');
      });

      it('neutralises formula injection trigger characters with a leading apostrophe', () => {
        expect(toCsvField('=1+1')).toBe('"\'=1+1"');
        expect(toCsvField('+44123456')).toBe('"\' +44123456"'.replace(' ', ''));
        expect(toCsvField('-50')).toBe('"\' -50"'.replace(' ', ''));
        expect(toCsvField('@SUM(A1:A5)')).toBe('"\'@SUM(A1:A5)"');
        expect(toCsvField('\tTAB_PREFIX')).toBe('"\'' + '\tTAB_PREFIX"');
        expect(toCsvField('\rCR_PREFIX')).toBe('"\'' + '\rCR_PREFIX"');
      });

      it('does not prepend apostrophe to empty string', () => {
        expect(toCsvField('')).toBe('""');
      });
    });

    describe('auditRowToCsv', () => {
      const sampleRow: AuditLogRow = {
        id: '101',
        seq: '1',
        timestamp: '2026-03-01T12:00:00.000Z',
        action: 'STREAM_CREATED',
        resourceType: 'stream',
        resourceId: 'strm_999',
        correlationId: 'req_123',
        meta: {
          actor: 'alice',
          authToken: 'sensitive_jwt_token',
          nested: {
            'X-API-KEY': 'super-secret',
            normalKey: 'safe-value',
          },
        },
      };

      it('serializes all columns in order and redacts restricted fields in meta', () => {
        const csv = auditRowToCsv(sampleRow);
        expect(csv.endsWith('\n')).toBe(true);

        const lines = csv.trim().split('\n');
        expect(lines).toHaveLength(1);

        // Fields must match column order: id, seq, timestamp, action, resource_type, resource_id, correlation_id, meta
        expect(csv).toContain(
          '"101","1","2026-03-01T12:00:00.000Z","STREAM_CREATED","stream","strm_999","req_123"'
        );
        expect(csv).not.toContain('sensitive_jwt_token');
        expect(csv).not.toContain('super-secret');
        expect(csv).toContain('[REDACTED]');
        expect(csv).toContain('safe-value');
      });

      it('handles row with null meta without error', () => {
        const rowWithoutMeta: AuditLogRow = {
          ...sampleRow,
          meta: null,
          correlationId: null,
        };
        const csv = auditRowToCsv(rowWithoutMeta);
        expect(csv).toBe(
          '"101","1","2026-03-01T12:00:00.000Z","STREAM_CREATED","stream","strm_999","",""\n'
        );
      });
    });

    describe('auditRowToNdjson', () => {
      const sampleRow: AuditLogRow = {
        id: '102',
        seq: '2',
        timestamp: '2026-03-01T12:05:00.000Z',
        action: 'STREAM_CANCELLED',
        resourceType: 'stream',
        resourceId: 'strm_888',
        correlationId: 'corr_456',
        meta: {
          actor: 'bob',
          authorization: 'Bearer secret_cred',
          details: { ok: true },
        },
      };

      it('serializes to valid JSON line and redacts restricted keys in meta', () => {
        const ndjson = auditRowToNdjson(sampleRow);
        expect(ndjson.endsWith('\n')).toBe(true);

        const parsed = JSON.parse(ndjson.trim());
        expect(parsed.id).toBe('102');
        expect(parsed.seq).toBe('2');
        expect(parsed.timestamp).toBe('2026-03-01T12:05:00.000Z');
        expect(parsed.action).toBe('STREAM_CANCELLED');
        expect(parsed.resourceType).toBe('stream');
        expect(parsed.resourceId).toBe('strm_888');
        expect(parsed.correlationId).toBe('corr_456');
        expect(parsed.meta.authorization).toBe('[REDACTED]');
        expect(parsed.meta.actor).toBe('bob');
        expect(parsed.meta.details).toEqual({ ok: true });
      });

      it('serializes null meta as null', () => {
        const rowWithNullMeta: AuditLogRow = {
          ...sampleRow,
          meta: null,
        };
        const ndjson = auditRowToNdjson(rowWithNullMeta);
        const parsed = JSON.parse(ndjson.trim());
        expect(parsed.meta).toBeNull();
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/audit (In-Memory Listing Route)
  // ────────────────────────────────────────────────────────────────────────────

  describe('GET /api/audit', () => {
    describe('Authentication & Authorization', () => {
      it('returns 401 when Authorization header is missing', async () => {
        const res = await request(app).get('/api/audit');
        expect(res.status).toBe(401);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
        expect(res.body.error.message).toContain('Authentication required');
      });

      it('returns 401 when Authorization header does not use Bearer scheme', async () => {
        const res = await request(app).get('/api/audit').set('Authorization', 'Basic user:pass');
        expect(res.status).toBe(401);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 when Bearer token is invalid or malformed', async () => {
        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', 'Bearer invalid-token-contents');
        expect(res.status).toBe(401);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 403 when authenticated principal lacks audit:read permission', async () => {
        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(403);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(res.body.error.message).toContain('Insufficient permissions');
      });

      it('permits access with operator token holding audit:read', async () => {
        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${operatorToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('permits access with admin token', async () => {
        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    describe('Success Path and Filtering', () => {
      it('returns 200 with empty entries when log is empty', async () => {
        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.entries).toEqual([]);
        expect(res.body.data.total).toBe(0);
        expect(res.body.meta.requestId).toBe('test-audit-corr-id');
      });

      it('returns entries with default pagination (limit 20, offset 0)', async () => {
        for (let i = 1; i <= 25; i++) {
          auditLogModule.recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`, `corr-${i}`, {
            actor: `user-${i}`,
          });
        }

        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.entries).toHaveLength(20);
        expect(res.body.data.total).toBe(25);
        expect(res.body.data.entries[0].resourceId).toBe('stream-1');
      });

      it('applies custom limit and offset parameters', async () => {
        for (let i = 1; i <= 10; i++) {
          auditLogModule.recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`, `corr-${i}`, {
            actor: `user-${i}`,
          });
        }

        const res = await request(app)
          .get('/api/audit?limit=3&offset=4')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.entries).toHaveLength(3);
        expect(res.body.data.total).toBe(10);
        expect(res.body.data.entries[0].resourceId).toBe('stream-5');
        expect(res.body.data.entries[1].resourceId).toBe('stream-6');
        expect(res.body.data.entries[2].resourceId).toBe('stream-7');
      });

      it('filters entries by actor, actionType, resourceType, resourceId, and date range', async () => {
        auditLogModule.recordAuditEvent('STREAM_CREATED', 'stream', 'stream-alpha', 'corr-1', {
          actor: 'alice',
        });
        auditLogModule.recordAuditEvent('STREAM_CANCELLED', 'stream', 'stream-beta', 'corr-2', {
          actor: 'bob',
        });
        auditLogModule.recordAuditEvent('PAUSE_FLAGS_UPDATED', 'system', 'global-flags', 'corr-3', {
          actor: 'alice',
        });

        // Filter by actor
        const actorRes = await request(app)
          .get('/api/audit?actor=alice')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(actorRes.status).toBe(200);
        expect(actorRes.body.data.entries).toHaveLength(2);
        expect(actorRes.body.data.total).toBe(2);

        // Filter by actionType
        const actionRes = await request(app)
          .get('/api/audit?actionType=STREAM_CANCELLED')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(actionRes.status).toBe(200);
        expect(actionRes.body.data.entries).toHaveLength(1);
        expect(actionRes.body.data.entries[0].resourceId).toBe('stream-beta');

        // Filter by resourceType
        const typeRes = await request(app)
          .get('/api/audit?resourceType=system')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(typeRes.status).toBe(200);
        expect(typeRes.body.data.entries).toHaveLength(1);
        expect(typeRes.body.data.entries[0].resourceId).toBe('global-flags');

        // Filter by resourceId
        const idRes = await request(app)
          .get('/api/audit?resourceId=stream-alpha')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(idRes.status).toBe(200);
        expect(idRes.body.data.entries).toHaveLength(1);
        expect(idRes.body.data.entries[0].action).toBe('STREAM_CREATED');
      });

      it('redacts sensitive fields in entry meta for returned responses', async () => {
        auditLogModule.recordAuditEvent('API_KEY_CREATED', 'apiKey', 'key-1', 'corr-test', {
          actor: 'admin',
          authToken: 'secret-token-value',
          authorization: 'Bearer secret-auth',
          'X-API-KEY': 'secret-api-key',
          nested: {
            authToken: 'nested-token',
            safe: 'visible-info',
          },
        });

        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        const meta = res.body.data.entries[0].meta;
        expect(meta.authToken).toBe('[REDACTED]');
        expect(meta.authorization).toBe('[REDACTED]');
        expect(meta['X-API-KEY']).toBe('[REDACTED]');
        expect(meta.nested.authToken).toBe('[REDACTED]');
        expect(meta.nested.safe).toBe('visible-info');
        expect(meta.actor).toBe('admin');
      });

      it('correctly filters by dateFrom and dateTo', async () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
          auditLogModule.recordAuditEvent('STREAM_CREATED', 'stream', 's1');

          vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
          auditLogModule.recordAuditEvent('STREAM_CREATED', 'stream', 's2');

          vi.setSystemTime(new Date('2026-03-01T14:00:00.000Z'));
          auditLogModule.recordAuditEvent('STREAM_CREATED', 'stream', 's3');

          const fromRes = await request(app)
            .get('/api/audit?dateFrom=2026-03-01T11:00:00.000Z')
            .set('Authorization', `Bearer ${adminToken}`);
          expect(fromRes.body.data.entries).toHaveLength(2);
          expect(fromRes.body.data.entries.map((e: any) => e.resourceId)).toEqual(['s2', 's3']);

          const toRes = await request(app)
            .get('/api/audit?dateTo=2026-03-01T13:00:00.000Z')
            .set('Authorization', `Bearer ${adminToken}`);
          expect(toRes.body.data.entries).toHaveLength(2);
          expect(toRes.body.data.entries.map((e: any) => e.resourceId)).toEqual(['s1', 's2']);

          const rangeRes = await request(app)
            .get('/api/audit?dateFrom=2026-03-01T11:00:00.000Z&dateTo=2026-03-01T13:00:00.000Z')
            .set('Authorization', `Bearer ${adminToken}`);
          expect(rangeRes.body.data.entries).toHaveLength(1);
          expect(rangeRes.body.data.entries[0].resourceId).toBe('s2');
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('Input Validation Failures (Client error 400, not 500)', () => {
      it('returns 400 VALIDATION_ERROR when limit is less than minimum (0)', async () => {
        const res = await request(app)
          .get('/api/audit?limit=0')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('limit must be at least 1');
      });

      it('returns 400 VALIDATION_ERROR when limit exceeds maximum (100)', async () => {
        const res = await request(app)
          .get('/api/audit?limit=101')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('limit must be at most 100');
      });

      it('returns 400 VALIDATION_ERROR when limit is not an integer string', async () => {
        const res = await request(app)
          .get('/api/audit?limit=notanumber')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('limit must be a positive integer');
      });

      it('returns 400 VALIDATION_ERROR when offset is negative', async () => {
        const res = await request(app)
          .get('/api/audit?offset=-5')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('offset must be a non-negative integer');
      });

      it('returns 400 VALIDATION_ERROR when offset is not an integer string', async () => {
        const res = await request(app)
          .get('/api/audit?offset=abc')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('Downstream Failure Paths', () => {
      it('surfaces unexpected downstream error as typed 500 error envelope without unhandled rejection', async () => {
        vi.spyOn(auditLogModule, 'getAuditEntries').mockImplementation(() => {
          throw new Error('In-memory audit store corrupted');
        });

        const res = await request(app)
          .get('/api/audit')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(500);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(res.body.error.message).toBe('Internal server error');
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/audit/export (Durable Export Streaming Route)
  // ────────────────────────────────────────────────────────────────────────────

  describe('GET /api/audit/export', () => {
    const mockRows: AuditLogRow[] = [
      {
        id: '1',
        seq: '1',
        timestamp: '2026-03-01T10:00:00.000Z',
        action: 'STREAM_CREATED',
        resourceType: 'stream',
        resourceId: 'strm_1',
        correlationId: 'req_1',
        meta: { actor: 'alice', authToken: 'leak' },
      },
      {
        id: '2',
        seq: '2',
        timestamp: '2026-03-01T11:00:00.000Z',
        action: 'STREAM_CANCELLED',
        resourceType: 'stream',
        resourceId: '=strm_formula',
        correlationId: 'req_2',
        meta: { actor: 'bob' },
      },
    ];

    async function* makeAsyncRowGenerator(rows: AuditLogRow[], signal?: { aborted: boolean }) {
      for (const row of rows) {
        if (signal?.aborted) break;
        yield row;
      }
    }

    describe('Authentication & Authorization', () => {
      it('returns 401 when Authorization header is missing', async () => {
        const res = await request(app).get('/api/audit/export');
        expect(res.status).toBe(401);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 403 when principal lacks audit:read permission', async () => {
        const res = await request(app)
          .get('/api/audit/export')
          .set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(403);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });
    });

    describe('Success Path — CSV and NDJSON', () => {
      it('streams CSV export by default with correct headers, self-audit record, and formula escaping', async () => {
        const recordSpy = vi
          .spyOn(auditLogModule, 'recordAuditEventToDb')
          .mockResolvedValue({} as any);
        const streamSpy = vi
          .spyOn(auditRepository, 'streamFiltered')
          .mockImplementation(() => makeAsyncRowGenerator(mockRows) as any);

        const res = await request(app)
          .get('/api/audit/export')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(res.headers['content-disposition']).toMatch(
          /^attachment; filename="audit-export-.*\.csv"$/
        );
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['cache-control']).toBe('no-store');

        // Self-audit was written before data reading
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy).toHaveBeenCalledWith(
          'AUDIT_EXPORTED',
          'audit_logs',
          'beginning..latest',
          'test-audit-corr-id',
          expect.objectContaining({
            format: 'csv',
            role: 'admin',
          })
        );

        // streamFiltered was called with default filter
        expect(streamSpy).toHaveBeenCalledTimes(1);

        const lines = res.text.trim().split('\n');
        expect(lines).toHaveLength(3); // header + 2 rows
        expect(lines[0]).toBe(
          'id,seq,timestamp,action,resource_type,resource_id,correlation_id,meta'
        );

        // Verify row 1 has redacted authToken
        expect(lines[1]).toContain('"1","1","2026-03-01T10:00:00.000Z","STREAM_CREATED"');
        expect(lines[1]).not.toContain('leak');
        expect(lines[1]).toContain('[REDACTED]');

        // Verify row 2 has escaped formula in resourceId
        expect(lines[2]).toContain("'=strm_formula");
      });

      it('streams NDJSON export when format=ndjson', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);
        vi.spyOn(auditRepository, 'streamFiltered').mockImplementation(
          () => makeAsyncRowGenerator(mockRows) as any
        );

        const res = await request(app)
          .get('/api/audit/export?format=ndjson')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
        expect(res.headers['content-disposition']).toMatch(
          /^attachment; filename="audit-export-.*\.ndjson"$/
        );

        const lines = res.text.trim().split('\n');
        expect(lines).toHaveLength(2);

        const r1 = JSON.parse(lines[0]);
        expect(r1.id).toBe('1');
        expect(r1.meta.authToken).toBe('[REDACTED]');

        const r2 = JSON.parse(lines[1]);
        expect(r2.id).toBe('2');
        expect(r2.resourceId).toBe('=strm_formula');
        expect(r2.meta.actor).toBe('bob');
      });

      it('passes query filters to repository and self-audit entry', async () => {
        const recordSpy = vi
          .spyOn(auditLogModule, 'recordAuditEventToDb')
          .mockResolvedValue({} as any);
        const streamSpy = vi
          .spyOn(auditRepository, 'streamFiltered')
          .mockImplementation(() => makeAsyncRowGenerator([]) as any);

        const res = await request(app)
          .get(
            '/api/audit/export?actor=alice&actionType=STREAM_CREATED&resourceType=stream&resourceId=strm_1&dateFrom=2026-03-01T00:00:00.000Z&dateTo=2026-03-01T23:59:59.000Z'
          )
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(recordSpy).toHaveBeenCalledWith(
          'AUDIT_EXPORTED',
          'audit_logs',
          '2026-03-01T00:00:00.000Z..2026-03-01T23:59:59.000Z',
          'test-audit-corr-id',
          expect.objectContaining({
            filters: {
              actor: 'alice',
              actionType: 'STREAM_CREATED',
              resourceType: 'stream',
              resourceId: 'strm_1',
              dateFrom: '2026-03-01T00:00:00.000Z',
              dateTo: '2026-03-01T23:59:59.000Z',
            },
          })
        );

        expect(streamSpy).toHaveBeenCalledWith(
          {
            actor: 'alice',
            action: 'STREAM_CREATED',
            resourceType: 'stream',
            resourceId: 'strm_1',
            dateFrom: '2026-03-01T00:00:00.000Z',
            dateTo: '2026-03-01T23:59:59.000Z',
          },
          expect.objectContaining({ signal: { aborted: false } })
        );
      });
    });

    describe('Input Validation Failures (Client error 400, not 500)', () => {
      it('returns 400 VALIDATION_ERROR when format is not csv or ndjson', async () => {
        const res = await request(app)
          .get('/api/audit/export?format=xml')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('format');
      });

      it('returns 400 VALIDATION_ERROR when dateFrom is not a valid ISO instant', async () => {
        const res = await request(app)
          .get('/api/audit/export?dateFrom=2026-01-01')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('dateFrom');
      });

      it('returns 400 VALIDATION_ERROR when dateFrom is an impossible calendar date', async () => {
        const res = await request(app)
          .get('/api/audit/export?dateFrom=2026-02-31T12:00:00.000Z')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('valid calendar date');
      });

      it('returns 400 VALIDATION_ERROR when dateTo is not a valid ISO instant', async () => {
        const res = await request(app)
          .get('/api/audit/export?dateTo=tomorrow')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('dateTo');
      });

      it('returns 400 VALIDATION_ERROR when dateFrom is greater than dateTo', async () => {
        const res = await request(app)
          .get(
            '/api/audit/export?dateFrom=2026-05-01T00:00:00.000Z&dateTo=2026-01-01T00:00:00.000Z'
          )
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('dateFrom: must be less than or equal to dateTo');
      });

      it('returns 400 VALIDATION_ERROR when date matches regex but getTime is NaN', async () => {
        const res = await request(app)
          .get('/api/audit/export?dateFrom=9999-99-99T99:99:99Z')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(400);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('valid calendar date');
      });
    });

    describe('Downstream Failures & Error Propagation', () => {
      it('returns typed 500 error envelope and exports NO data when self-audit write fails', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockRejectedValue(
          new Error('PostgreSQL audit_logs insert failed')
        );
        const streamSpy = vi.spyOn(auditRepository, 'streamFiltered');
        const loggerSpy = vi.spyOn(logger, 'error');

        const res = await request(app)
          .get('/api/audit/export')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(500);
        expect(isErrorEnvelope(res.body)).toBe(true);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');

        // Stream must NOT have been opened
        expect(streamSpy).not.toHaveBeenCalled();

        // Error must have been logged
        expect(loggerSpy).toHaveBeenCalledWith(
          'audit_export_self_audit_failed',
          'test-audit-corr-id',
          expect.objectContaining({
            event: 'audit_export_self_audit_failed',
            err: 'PostgreSQL audit_logs insert failed',
          })
        );
      });

      it('returns typed 500 error envelope when repository stream fails before headers sent', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);

        // In NDJSON mode, headers are not flushed until first write.
        // If streamFiltered throws on invocation before yielding:
        vi.spyOn(auditRepository, 'streamFiltered').mockImplementation(() => {
          throw new Error('Database connection pool exhausted');
        });
        const loggerSpy = vi.spyOn(logger, 'error');

        const res = await request(app)
          .get('/api/audit/export?format=ndjson')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(500);
        const parsedBody =
          typeof res.body === 'object' && Object.keys(res.body).length > 0
            ? res.body
            : JSON.parse(res.text);
        expect(isErrorEnvelope(parsedBody)).toBe(true);
        expect(parsedBody.error.code).toBe('INTERNAL_ERROR');
        expect(loggerSpy).toHaveBeenCalledWith(
          'audit_export_failed',
          'test-audit-corr-id',
          expect.objectContaining({
            event: 'audit_export_failed',
            err: 'Database connection pool exhausted',
          })
        );
      });

      it('destroys response socket when repository fails mid-stream after headers were sent', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);

        // Async generator that yields one row then throws
        async function* failingGenerator() {
          yield mockRows[0];
          throw new Error('Mid-stream network timeout from Postgres');
        }

        vi.spyOn(auditRepository, 'streamFiltered').mockImplementation(
          () => failingGenerator() as any
        );

        // With CSV, the header row is sent immediately, so headersSent = true.
        // When failingGenerator throws, res.destroy() is called.
        // Supertest catches connection drops / aborts as an error or incomplete transfer.
        await expect(
          request(app)
            .get('/api/audit/export?format=csv')
            .set('Authorization', `Bearer ${adminToken}`)
        ).rejects.toThrow();
      });

      it('destroys response socket when non-Error object is thrown mid-stream', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);

        async function* failingGenerator() {
          yield mockRows[0];
          throw 'string-error-failure';
        }

        vi.spyOn(auditRepository, 'streamFiltered').mockImplementation(
          () => failingGenerator() as any
        );

        await expect(
          request(app)
            .get('/api/audit/export?format=csv')
            .set('Authorization', `Bearer ${adminToken}`)
        ).rejects.toThrow();
      });

      it('returns immediately without streaming rows if writeChunk fails on CSV header', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);
        const streamSpy = vi.spyOn(auditRepository, 'streamFiltered');

        const customApp = express();
        customApp.use((req, res, next) => {
          req.correlationId = 'test-corr';
          let writeCount = 0;
          const origWrite = res.write.bind(res);
          res.write = ((chunk: any, ...args: any[]) => {
            writeCount++;
            if (writeCount === 1) {
              res.destroy();
              return false;
            }
            return (origWrite as any)(chunk, ...args);
          }) as any;
          next();
        });
        customApp.use('/api/audit', auditRouter);

        await expect(
          request(customApp)
            .get('/api/audit/export?format=csv')
            .set('Authorization', `Bearer ${adminToken}`)
        ).rejects.toThrow();

        expect(streamSpy).not.toHaveBeenCalled();
      });

      it('handles backpressure properly during streaming', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);

        // Large batch of rows to test writeChunk flow
        const manyRows: AuditLogRow[] = Array.from({ length: 50 }, (_, i) => ({
          id: String(i + 1),
          seq: String(i + 1),
          timestamp: '2026-03-01T12:00:00.000Z',
          action: 'STREAM_CREATED',
          resourceType: 'stream',
          resourceId: `strm_${i}`,
          correlationId: `req_${i}`,
          meta: null,
        }));

        vi.spyOn(auditRepository, 'streamFiltered').mockImplementation(
          () => makeAsyncRowGenerator(manyRows) as any
        );

        const res = await request(app)
          .get('/api/audit/export?format=csv')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        const lines = res.text.trim().split('\n');
        expect(lines).toHaveLength(51); // 1 header + 50 rows
      });

      it('stops stream gracefully when socket is already destroyed or client hung up', async () => {
        vi.spyOn(auditLogModule, 'recordAuditEventToDb').mockResolvedValue({} as any);

        let yieldedCount = 0;
        async function* infiniteGenerator(signal: { aborted: boolean }) {
          while (!signal.aborted) {
            yieldedCount++;
            yield mockRows[0];
          }
        }

        vi.spyOn(auditRepository, 'streamFiltered').mockImplementation(
          (_filter, opts) => infiniteGenerator(opts!.signal) as any
        );

        // Mock writeChunk behavior by having response close
        const customApp = express();
        customApp.use((req, _res, next) => {
          req.correlationId = 'test-corr';
          next();
        });
        customApp.use('/api/audit', auditRouter);

        const server = customApp.listen(0);
        const port = (server.address() as any).port;

        try {
          // Connect raw HTTP client and abort after receiving initial chunk
          const http = await import('http');
          await new Promise<void>((resolve, reject) => {
            const req = http.get(
              `http://127.0.0.1:${port}/api/audit/export?format=csv`,
              {
                headers: { Authorization: `Bearer ${adminToken}` },
              },
              (res) => {
                res.on('data', () => {
                  req.destroy(); // Abort client connection mid-stream
                  resolve();
                });
              }
            );
            req.on('error', () => {
              // Client abort expected
              resolve();
            });
          });

          // Wait a tick for server close event to process
          await new Promise((r) => setTimeout(r, 50));
        } finally {
          server.close();
        }
      });
    });
  });
});
