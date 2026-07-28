/**
 * Verifies that logger calls across middleware and redis modules use the
 * correct (message, correlationId, meta) call signature, and that the
 * structured JSON output carries the correlationId and metadata fields
 * in the correct positions.
 *
 * One representative call site per file is tested.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { logger } from '../src/lib/logger.js';

describe('Logger call-signature correctness', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logger.warn receives (message, correlationId, meta)', () => {
    logger.warn('test warning', 'cid-42', { extra: 'data', count: 7 });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [message, correlationId, meta] = warnSpy.mock.calls[0];
    expect(message).toBe('test warning');
    expect(correlationId).toBe('cid-42');
    expect(meta).toEqual({ extra: 'data', count: 7 });
  });

  it('logger.info receives (message, correlationId, meta)', () => {
    logger.info('test info', 'cid-99', { method: 'GET', path: '/foo' });

    expect(infoSpy).toHaveBeenCalledOnce();
    const [message, correlationId, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('test info');
    expect(correlationId).toBe('cid-99');
    expect(meta).toEqual({ method: 'GET', path: '/foo' });
  });

  it('logger.error receives (message, correlationId, meta)', () => {
    logger.error('test error', 'cid-err', { operation: 'set', reason: 'timeout' });

    expect(errorSpy).toHaveBeenCalledOnce();
    const [message, correlationId, meta] = errorSpy.mock.calls[0];
    expect(message).toBe('test error');
    expect(correlationId).toBe('cid-err');
    expect(meta).toEqual({ operation: 'set', reason: 'timeout' });
  });

  it('logger.debug receives (message, correlationId, meta)', () => {
    logger.debug('test debug', 'cid-dbg', { operation: 'dedup', streamId: 's1' });

    expect(debugSpy).toHaveBeenCalledOnce();
    const [message, correlationId, meta] = debugSpy.mock.calls[0];
    expect(message).toBe('test debug');
    expect(correlationId).toBe('cid-dbg');
    expect(meta).toEqual({ operation: 'dedup', streamId: 's1' });
  });

  it('logger.info without correlationId passes undefined as second arg', () => {
    logger.info('no cid passed', undefined, { key: 'value' });

    expect(infoSpy).toHaveBeenCalledOnce();
    const [message, correlationId, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('no cid passed');
    expect(correlationId).toBeUndefined();
    expect(meta).toEqual({ key: 'value' });
  });

  it('logger.info with only message passes undefined correlationId and undefined meta', () => {
    logger.info('minimal');

    expect(infoSpy).toHaveBeenCalledOnce();
    const [message, correlationId, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('minimal');
    expect(correlationId).toBeUndefined();
    expect(meta).toBeUndefined();
  });
});

describe('requestLoggerMiddleware logger call-signature', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('request received: correlationId is second arg, method/path in third', async () => {
    const { requestLoggerMiddleware } = await import('../src/middleware/requestLogger.js');

    const req = {
      method: 'POST',
      path: '/api/streams',
      correlationId: 'req-logger-test',
    } as any;
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    const next = vi.fn();

    requestLoggerMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    const [message, cid, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('request received');
    expect(cid).toBe('req-logger-test');
    expect(meta).toEqual({ method: 'POST', path: '/api/streams' });
  });

  it('request completed: correlationId is second arg, meta is third', async () => {
    const { requestLoggerMiddleware } = await import('../src/middleware/requestLogger.js');

    const req = {
      method: 'GET',
      path: '/health',
      correlationId: 'cid-complete',
    } as any;
    const res = new EventEmitter() as any;
    res.statusCode = 200;

    requestLoggerMiddleware(req, res, vi.fn());
    res.emit('finish');

    const [message, cid, meta] = infoSpy.mock.calls[1];
    expect(message).toBe('request completed');
    expect(cid).toBe('cid-complete');
    expect(meta).toMatchObject({ method: 'GET', path: '/health', statusCode: 200 });
  });

  it('request failed (5xx): correlationId is second arg, meta is third', async () => {
    const { requestLoggerMiddleware } = await import('../src/middleware/requestLogger.js');

    const req = {
      method: 'DELETE',
      path: '/api/resource',
      correlationId: 'cid-fail',
    } as any;
    const res = new EventEmitter() as any;
    res.statusCode = 500;

    requestLoggerMiddleware(req, res, vi.fn());
    res.emit('finish');

    const [message, cid, meta] = errorSpy.mock.calls[0];
    expect(message).toBe('request failed');
    expect(cid).toBe('cid-fail');
    expect(meta).toMatchObject({ method: 'DELETE', path: '/api/resource', statusCode: 500 });
  });
});

describe('idempotency middleware logger call-signature', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('idempotency conflict: correlationId is second arg, meta is third', async () => {
    const { createIdempotencyMiddleware, hashBody } = await import('../src/middleware/idempotency.js');
    const { InMemoryIdempotencyStore } = await import('../src/redis/idempotencyStore.js');

    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware(store, 60);

    const body = { amount: 10 };
    const req1 = {
      method: 'POST',
      headers: { 'idempotency-key': 'conflict-key' },
      body,
      correlationId: 'cid-conflict',
    } as any;
    const res1: any = {
      statusCode: 200,
      set: vi.fn(),
      json: vi.fn(),
    };

    await mw(req1, res1, vi.fn());
    res1.json({ data: { id: 's1' } });

    const req2 = {
      method: 'POST',
      headers: { 'idempotency-key': 'conflict-key' },
      body: { amount: 999 },
      correlationId: 'cid-conflict-2',
    } as any;
    const res2: any = {
      statusCode: 200,
      set: vi.fn(),
      status(code: number) { res2.statusCode = code; return res2; },
      json: vi.fn(),
    };

    await mw(req2, res2, vi.fn());

    expect(warnSpy).toHaveBeenCalledOnce();
    const [message, cid, meta] = warnSpy.mock.calls[0];
    expect(message).toBe('Idempotency conflict detected');
    expect(cid).toBe('cid-conflict-2');
    expect(meta).toMatchObject({
      idempotencyKeyLength: 'conflict-key'.length,
      incomingHash: expect.any(String),
      storedHash: expect.any(String),
    });
  });

  it('idempotent replay: correlationId is second arg, meta is third', async () => {
    const { createIdempotencyMiddleware } = await import('../src/middleware/idempotency.js');
    const { InMemoryIdempotencyStore } = await import('../src/redis/idempotencyStore.js');

    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware(store, 60);

    const body = { amount: 10 };
    const req1 = {
      method: 'POST',
      headers: { 'idempotency-key': 'replay-key' },
      body,
      correlationId: 'cid-first',
    } as any;
    const res1: any = {
      statusCode: 200,
      set: vi.fn(),
      json: vi.fn(),
    };

    await mw(req1, res1, vi.fn());
    res1.json({ data: { id: 's1' } });

    const req2 = {
      method: 'POST',
      headers: { 'idempotency-key': 'replay-key' },
      body,
      correlationId: 'cid-replay',
    } as any;
    const res2: any = {
      statusCode: 200,
      set: vi.fn(),
      json: vi.fn(),
    };

    await mw(req2, res2, vi.fn());

    expect(infoSpy).toHaveBeenCalledOnce();
    const [message, cid, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('Replaying idempotent response');
    expect(cid).toBe('cid-replay');
    expect(meta).toMatchObject({ idempotencyKeyLength: 'replay-key'.length });
  });
});

describe('pii middleware logger call-signature', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requestLogger: correlationId is second arg, meta is third', async () => {
    const { requestLogger } = await import('../src/middleware/pii.js');

    const req = {
      method: 'GET',
      path: '/api/data',
      correlationId: 'cid-pii',
    } as any;
    const res = new EventEmitter() as any;
    res.statusCode = 200;

    requestLogger(req, res, vi.fn());
    res.emit('finish');

    expect(infoSpy).toHaveBeenCalledOnce();
    const [message, cid, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('http request');
    expect(cid).toBe('cid-pii');
    expect(meta).toMatchObject({
      method: 'GET',
      path: '/api/data',
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  it('safeErrorHandler: correlationId is second arg, meta is third', async () => {
    const { safeErrorHandler } = await import('../src/middleware/pii.js');

    const err = new Error('boom');
    const req = { correlationId: 'cid-err-handler' } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    safeErrorHandler(err, req, res, vi.fn());

    expect(errorSpy).toHaveBeenCalledOnce();
    const [message, cid, meta] = errorSpy.mock.calls[0];
    expect(message).toBe('unhandled error');
    expect(cid).toBe('cid-err-handler');
    expect(meta).toMatchObject({
      error: expect.any(String),
    });
  });
});
