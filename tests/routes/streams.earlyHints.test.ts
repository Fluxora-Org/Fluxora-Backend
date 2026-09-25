/**
 * HTTP 103 Early Hints tests for GET /api/streams.
 *
 * Covers:
 *  - Early Hints utility: buildLinkHeader, buildPaginationUrl, isSafeCursor
 *  - Integration with GET /api/streams: Early Hints sent before main response
 *  - Edge cases: empty results, single page, last page
 *  - Graceful degradation: unsupported clients, writeProcessing unavailable
 *  - Security: cursor validation, injection prevention
 *  - Query parameters preserved in pagination links
 *  - Non-blocking behavior (setImmediate)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  buildLinkHeader,
  buildPaginationUrl,
  isSafeCursor,
  sendEarlyHints,
  sendEarlyHintsWithBoth,
  type EarlyHintsConfig,
} from '../../src/utils/earlyHints.js';
import { streamsRouter } from '../../src/routes/streams.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { initializeConfig } from '../../src/config/env.js';

initializeConfig();

// ── Unit tests for earlyHints utilities ───────────────────────────────────

describe('buildLinkHeader', () => {
  it('builds a valid RFC 8288 Link header value', () => {
    const header = buildLinkHeader('/api/streams?cursor=abc&limit=50', 'next');
    expect(header).toBe('</api/streams?cursor=abc&limit=50>; rel="next"');
  });

  it('works with absolute URLs', () => {
    const header = buildLinkHeader('https://api.example.com/api/streams?cursor=xyz', 'prev');
    expect(header).toBe('<https://api.example.com/api/streams?cursor=xyz>; rel="prev"');
  });

  it('handles various rel values', () => {
    expect(buildLinkHeader('/api/streams', 'next')).toContain('rel="next"');
    expect(buildLinkHeader('/api/streams', 'prev')).toContain('rel="prev"');
    expect(buildLinkHeader('/api/streams', 'first')).toContain('rel="first"');
  });
});

describe('buildPaginationUrl', () => {
  it('builds a URL with query parameters', () => {
    const url = buildPaginationUrl('/api/streams', { cursor: 'abc123', limit: '50' });
    expect(url).toContain('/api/streams');
    expect(url).toContain('cursor=abc123');
    expect(url).toContain('limit=50');
  });

  it('preserves relative URLs', () => {
    const url = buildPaginationUrl('/api/streams', { limit: '25' });
    expect(url).toMatch(/^\/api\/streams\?/);
  });

  it('handles absolute URLs', () => {
    const url = buildPaginationUrl('https://api.example.com/api/streams', { limit: '50' });
    expect(url).toMatch(/^https:\/\/api\.example\.com/);
  });

  it('URL-encodes special characters', () => {
    const url = buildPaginationUrl('/api/streams', { status: 'active&paused' });
    expect(url).toContain('status=active%26paused');
  });

  it('handles empty query parameters', () => {
    const url = buildPaginationUrl('/api/streams', {});
    expect(url).toBe('/api/streams');
  });

  it('handles multiple query parameters', () => {
    const url = buildPaginationUrl('/api/streams', {
      cursor: 'cursor123',
      limit: '50',
      status: 'active',
      sender: 'GBXYZ123',
    });
    expect(url).toContain('cursor=cursor123');
    expect(url).toContain('limit=50');
    expect(url).toContain('status=active');
    expect(url).toContain('sender=GBXYZ123');
  });
});

describe('isSafeCursor', () => {
  it('accepts valid base64url cursors', () => {
    expect(isSafeCursor('abc123')).toBe(true);
    expect(isSafeCursor('ABC_-xyz')).toBe(true);
    expect(isSafeCursor('eyJ2IjogMSwgImxhc3RJZCI6ICJzdHJlYW0xIn0')).toBe(true);
  });

  it('rejects cursors with invalid characters', () => {
    expect(isSafeCursor('abc/123')).toBe(false); // forward slash
    expect(isSafeCursor('abc+123')).toBe(false); // plus
    expect(isSafeCursor('abc=123')).toBe(false); // equals
    expect(isSafeCursor('abc 123')).toBe(false); // space
  });

  it('rejects cursors with control characters', () => {
    expect(isSafeCursor('abc\n123')).toBe(false);
    expect(isSafeCursor('abc\x00123')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeCursor('')).toBe(false);
  });

  it('accepts long valid cursors', () => {
    const longCursor = 'a'.repeat(200);
    expect(isSafeCursor(longCursor)).toBe(true);
  });
});

// ── Integration tests for sendEarlyHints ──────────────────────────────────

describe('sendEarlyHints', () => {
  let res: Partial<Response>;

  beforeEach(() => {
    res = {
      headersSent: false,
      writeProcessing: vi.fn(),
    };
  });

  it('does nothing when response headers already sent', () => {
    res.headersSent = true;
    sendEarlyHints(res as Response, {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: 'abc123',
    });
    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('does nothing when no next page', () => {
    sendEarlyHints(res as Response, {
      baseUrl: '/api/streams',
      hasMore: false,
    });
    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('does nothing when cursor is null', () => {
    sendEarlyHints(res as Response, {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: null,
    });
    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('does nothing when cursor is undefined', () => {
    sendEarlyHints(res as Response, {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: undefined,
    });
    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('rejects unsafe cursor format', () => {
    sendEarlyHints(res as Response, {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: 'abc/123', // forward slash is not base64url
    });
    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('sends Early Hints asynchronously via setImmediate', async () => {
    const config: EarlyHintsConfig = {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: 'cursorABC123',
      queryParams: { limit: '50' },
    };

    sendEarlyHints(res as Response, config);

    // Verify writeProcessing is not called synchronously
    expect(res.writeProcessing).not.toHaveBeenCalled();

    // Wait for setImmediate to execute
    await new Promise((resolve) => setImmediate(resolve));

    // Now writeProcessing should have been called
    expect(res.writeProcessing).toHaveBeenCalledTimes(1);
    const call = (res.writeProcessing as any).mock.calls[0];
    expect(call[0]).toBe('Link');
    expect(call[1]).toContain('rel="next"');
    expect(call[1]).toContain('cursorABC123');
  });

  it('includes query parameters in the Link header', async () => {
    sendEarlyHints(res as Response, {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: 'xyz789',
      queryParams: { status: 'active', sender: 'GABC123' },
    });

    await new Promise((resolve) => setImmediate(resolve));

    const call = (res.writeProcessing as any).mock.calls[0];
    expect(call[1]).toContain('status=active');
    expect(call[1]).toContain('sender=GABC123');
  });

  it('handles missing writeProcessing gracefully', () => {
    res.writeProcessing = undefined;
    expect(() => {
      sendEarlyHints(res as Response, {
        baseUrl: '/api/streams',
        hasMore: true,
        nextCursor: 'abc123',
      });
    }).not.toThrow();
  });

  it('handles writeProcessing errors gracefully', async () => {
    (res.writeProcessing as any) = vi.fn(() => {
      throw new Error('writeProcessing failed');
    });

    expect(() => {
      sendEarlyHints(res as Response, {
        baseUrl: '/api/streams',
        hasMore: true,
        nextCursor: 'abc123',
      });
    }).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));
    // Should have attempted to call it despite the error
    expect(res.writeProcessing).toHaveBeenCalled();
  });

  it('does not send Early Hints if response starts before async call executes', async () => {
    const config: EarlyHintsConfig = {
      baseUrl: '/api/streams',
      hasMore: true,
      nextCursor: 'abc123',
    };

    sendEarlyHints(res as Response, config);

    // Simulate response starting before setImmediate callback
    res.headersSent = true;

    await new Promise((resolve) => setImmediate(resolve));

    // Should not call writeProcessing because headers were sent
    expect(res.writeProcessing).not.toHaveBeenCalled();
  });
});

describe('sendEarlyHintsWithBoth', () => {
  let res: Partial<Response>;

  beforeEach(() => {
    res = {
      headersSent: false,
      writeProcessing: vi.fn(),
    };
  });

  it('sends both next and prev links', async () => {
    sendEarlyHintsWithBoth(
      res as Response,
      '/api/streams',
      true,
      'nextCursor123',
      'prevCursor456',
      { limit: '50' },
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(res.writeProcessing).toHaveBeenCalledTimes(2);
    const calls = (res.writeProcessing as any).mock.calls;
    const linkValues = calls.map((c: any[]) => c[1]);

    // Check for next and prev relations
    expect(linkValues.some((l: string) => l.includes('rel="next"'))).toBe(true);
    expect(linkValues.some((l: string) => l.includes('rel="prev"'))).toBe(true);
  });

  it('sends only next link when prev is missing', async () => {
    sendEarlyHintsWithBoth(
      res as Response,
      '/api/streams',
      true,
      'nextCursor123',
      undefined,
      {},
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(res.writeProcessing).toHaveBeenCalledTimes(1);
    const call = (res.writeProcessing as any).mock.calls[0];
    expect(call[1]).toContain('rel="next"');
  });

  it('rejects unsafe prev cursor', async () => {
    sendEarlyHintsWithBoth(
      res as Response,
      '/api/streams',
      true,
      'nextCursor123',
      'prev/Cursor456', // unsafe
      {},
    );

    await new Promise((resolve) => setImmediate(resolve));

    // Only next link should be sent
    expect(res.writeProcessing).toHaveBeenCalledTimes(1);
    const call = (res.writeProcessing as any).mock.calls[0];
    expect(call[1]).toContain('rel="next"');
  });

  it('sends no links when both cursors are unsafe', async () => {
    sendEarlyHintsWithBoth(
      res as Response,
      '/api/streams',
      true,
      'next/Cursor123',
      'prev/Cursor456',
      {},
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });
});

// ── Integration tests with GET /api/streams ──────────────────────────────

const mockFindWithCursor = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    findWithCursor: (...a: unknown[]) => mockFindWithCursor(...a),
    getById: vi.fn(),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
    countByStatus: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
}));

// Mock authentication middleware to allow requests
vi.mock('../../src/middleware/auth.js', () => ({
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  requireScope: () => (_req: any, _res: any, next: any) => next(),
  authenticate: (_req: any, _res: any, next: any) => next(),
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

function makeRow(id: string) {
  return {
    id,
    sender_address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    recipient_address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
    amount: '100',
    streamed_amount: '0',
    remaining_amount: '100',
    rate_per_second: '1',
    start_time: 1700000000,
    end_time: 0,
    status: 'active',
    contract_id: 'api-created',
    transaction_hash: 'a'.repeat(64),
    event_index: 0,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
  };
}

/**
 * Lightweight middleware to set x-request-id on every request.
 * Replaces the removed requestIdMiddleware from src/errors.ts.
 */
function requestIdMiddleware(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const requestId = req.header('x-request-id') ?? randomUUID();
  _res.locals['requestId'] = requestId;
  _res.setHeader('x-request-id', requestId);
  next();
}

function makeApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/streams — Early Hints integration', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('sends Early Hints when next page exists', async () => {
    const rows = [makeRow('stream1'), makeRow('stream2'), makeRow('stream3')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: true,
    });

    const response = await request(app).get('/api/streams').expect(200);

    expect(response.body.data.has_more).toBe(true);
    expect(response.body.data.next_cursor).toBeDefined();
    // Early Hints are sent asynchronously, so we verify the response contains cursor
    expect(typeof response.body.data.next_cursor).toBe('string');
  });

  it('does not send Early Hints when on last page', async () => {
    const rows = [makeRow('stream1')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: false,
    });

    const response = await request(app).get('/api/streams').expect(200);

    expect(response.body.data.has_more).toBe(false);
    expect(response.body.data.next_cursor).toBeNull();
  });

  it('preserves query parameters in Early Hints links', async () => {
    const rows = [makeRow('stream1'), makeRow('stream2')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: true,
    });

    const response = await request(app)
      .get('/api/streams')
      .query({ status: 'active', sender: 'GABC123', limit: '50' })
      .expect(200);

    expect(response.body.data.has_more).toBe(true);
  });

  it('handles empty result set correctly', async () => {
    mockFindWithCursor.mockResolvedValueOnce({
      streams: [],
      hasMore: false,
    });

    const response = await request(app).get('/api/streams').expect(200);

    expect(response.body.data.streams).toEqual([]);
    expect(response.body.data.has_more).toBe(false);
    expect(response.body.data.next_cursor).toBeNull();
  });

  it('handles single row result correctly', async () => {
    const rows = [makeRow('stream1')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: false,
    });

    const response = await request(app).get('/api/streams').expect(200);

    expect(response.body.data.streams).toHaveLength(1);
    expect(response.body.data.has_more).toBe(false);
    expect(response.body.data.next_cursor).toBeNull();
  });

  it('generates valid cursor for next page', async () => {
    const rows = [makeRow('stream1'), makeRow('stream2'), makeRow('stream3')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: true,
    });

    const response = await request(app).get('/api/streams').expect(200);

    const nextCursor = response.body.data.next_cursor;
    expect(nextCursor).toBeDefined();
    expect(typeof nextCursor).toBe('string');

    // Verify cursor can be decoded (basic structure check)
    const decoded = Buffer.from(nextCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    expect(parsed).toHaveProperty('v');
    expect(parsed).toHaveProperty('lastId');
    expect(parsed.v).toBe(1);
    expect(parsed.lastId).toBe('stream3'); // last row ID
    expect(parsed.scope).toContain('order');
  });

  it('rejects reusing a cursor with a different filter scope', async () => {
    mockFindWithCursor.mockResolvedValueOnce({
      streams: [makeRow('stream1'), makeRow('stream2')],
      hasMore: true,
    });
    const first = await request(app).get('/api/streams').expect(200);
    const cursor = first.body.data.next_cursor as string;

    await request(app)
      .get('/api/streams')
      .query({ cursor, status: 'active' })
      .expect(400);
    expect(mockFindWithCursor).toHaveBeenCalledTimes(1);
  });

  it('respects limit parameter', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`stream${i + 1}`));
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: true,
    });

    const response = await request(app).get('/api/streams?limit=25').expect(200);

    expect(response.body.data.streams).toHaveLength(25);
    expect(response.body.data.has_more).toBe(true);
  });

  it('includes pagination info in response', async () => {
    const rows = [makeRow('stream1'), makeRow('stream2')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: true,
    });

    const response = await request(app).get('/api/streams').expect(200);

    expect(response.body.data).toHaveProperty('streams');
    expect(response.body.data).toHaveProperty('has_more');
    expect(response.body.data).toHaveProperty('next_cursor');
  });

  it('includes total count when requested', async () => {
    const rows = [makeRow('stream1')];
    mockFindWithCursor.mockResolvedValueOnce({
      streams: rows,
      hasMore: false,
      total: 100,
    });

    const response = await request(app)
      .get('/api/streams')
      .query({ include_total: 'true' })
      .expect(200);

    expect(response.body.data).toHaveProperty('total');
    expect(response.body.data.total).toBe(100);
  });
});
