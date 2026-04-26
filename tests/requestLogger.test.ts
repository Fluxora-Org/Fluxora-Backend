import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { requestLoggerMiddleware } from '../src/middleware/requestLogger.js';
import { logger, _resetLoggerForTest } from '../src/logging/logger.js';

interface MockReq {
  method: string;
  path: string;
  ip?: string;
  headers?: Record<string, string>;
  correlationId?: string;
}

type MockRes = EventEmitter & { statusCode: number };

function createReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    method: 'GET',
    path: '/health',
    ip: '127.0.0.1',
    headers: { authorization: 'Bearer secret-token' },
    correlationId: 'cid-123',
    ...overrides,
  };
}

function createRes(statusCode = 200): MockRes {
  const emitter = new EventEmitter() as MockRes;
  emitter.statusCode = statusCode;
  return emitter;
}

describe('requestLogger middleware', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetLoggerForTest();
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs request received and completed for non-5xx responses', () => {
    const req = createReq();
    const res = createRes(200);
    const next = vi.fn();

    requestLoggerMiddleware(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy.mock.calls[0][0]).toBe('request received');
    expect(infoSpy.mock.calls[1][0]).toBe('request completed');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs request failed for 5xx responses and avoids completed log', () => {
    const req = createReq({ path: '/explode' });
    const res = createRes(500);

    requestLoggerMiddleware(req, res, vi.fn());
    res.emit('finish');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toBe('request received');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toBe('request failed');
  });

  it('includes correlationId on structured metadata', () => {
    const req = createReq({ correlationId: 'req-abc' });
    const res = createRes(204);

    requestLoggerMiddleware(req, res, vi.fn());
    res.emit('finish');

    const receivedMeta = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    const completedMeta = infoSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(receivedMeta.correlationId).toBe('req-abc');
    expect(completedMeta.correlationId).toBe('req-abc');
  });

  it('does not include ip or authorization data in emitted metadata', () => {
    const req = createReq();
    const res = createRes(200);

    requestLoggerMiddleware(req, res, vi.fn());
    res.emit('finish');

    const receivedMeta = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    const completedMeta = infoSpy.mock.calls[1][1] as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(receivedMeta, 'ip')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(receivedMeta, 'authorization')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(completedMeta, 'ip')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(completedMeta, 'authorization')).toBe(false);
  });

  it('includes duration and status in terminal log metadata', () => {
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145);

    const req = createReq();
    const res = createRes(201);

    requestLoggerMiddleware(req, res, vi.fn());
    res.emit('finish');

    const completedMeta = infoSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(completedMeta.statusCode).toBe(201);
    expect(completedMeta.durationMs).toBe(45);

    nowSpy.mockRestore();
  });
});
