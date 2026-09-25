import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  CANARY_HEADER,
  createCanaryRoutingMiddleware,
  computeCanaryBucket,
} from '../../src/middleware/canaryRouting.js';

function request(headers: Record<string, string> = {}): Request {
  return {
    headers,
    ip: '198.51.100.10',
  } as unknown as Request;
}

function response(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

describe('canary routing middleware', () => {
  it('keeps one variant for every request in a session', () => {
    const middleware = createCanaryRoutingMiddleware({ trafficPercent: 50, salt: 'test' });
    const next = vi.fn();
    const firstRequest = request({ 'x-session-id': 'session-1' });
    const firstResponse = response();

    middleware(firstRequest, firstResponse, next);

    const expected = firstRequest.isCanary;
    for (let index = 0; index < 20; index += 1) {
      const nextRequest = request({ 'x-session-id': 'session-1' });
      const nextResponse = response();
      middleware(nextRequest, nextResponse, next);
      expect(nextRequest.isCanary).toBe(expected);
      expect(nextResponse.headers[CANARY_HEADER]).toBe(String(expected));
    }
  });

  it('enforces configured share and exposes the assignment', () => {
    const middleware = createCanaryRoutingMiddleware({ trafficPercent: 100, salt: 'test' });
    const req = request({ 'x-session-id': 'session-100' });
    const res = response();

    middleware(req, res, vi.fn());

    expect(req.isCanary).toBe(true);
    expect(res.headers[CANARY_HEADER]).toBe('true');
    expect(computeCanaryBucket('test', 'session-100')).toBeGreaterThanOrEqual(0);
  });

  it('routes all traffic to stable when canary is disabled', () => {
    const middleware = createCanaryRoutingMiddleware({ trafficPercent: 0 });
    const req = request({ 'x-session-id': 'session-disabled' });
    const res = response();

    middleware(req, res, vi.fn());

    expect(req.isCanary).toBe(false);
    expect(res.headers[CANARY_HEADER]).toBe('false');
  });
});