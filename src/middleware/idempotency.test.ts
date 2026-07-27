import { describe, it, expect, vi } from 'vitest';
import { createIdempotencyMiddleware, hashBody, canonicalizeBody } from '../middleware/idempotency.js';
import { InMemoryIdempotencyStore } from '../redis/idempotencyStore.js';

function mockRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function mockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    headers: {},
    body: {},
    id: 'req-1',
    ...overrides,
  } as any;
}

describe('idempotency collision detection', () => {
  it('canonicalizes bodies so key order does not change the fingerprint', () => {
    const a = canonicalizeBody({ b: 1, a: 2 });
    const b = canonicalizeBody({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(hashBody({ b: 1, a: 2 })).toBe(hashBody({ a: 2, b: 1 }));
  });

  it('replays the cached response when the same key + body is reused', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware(store, 60);
    const req = mockReq({ headers: { 'idempotency-key': 'k1' }, body: { amount: 10 } });
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    // Simulate the handler caching a successful response.
    res.status(201).json({ data: { id: 's1' } });

    // Replay with identical key + body -> returns cached response, no next().
    const req2 = mockReq({ headers: { 'idempotency-key': 'k1' }, body: { amount: 10 } });
    const res2 = mockRes();
    const next2 = vi.fn();
    await mw(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(201);
    expect((res2.body as any).data.id).toBe('s1');
  });

  it('returns 409 when the same key is reused with a different body', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware(store, 60);

    // First request stores a response for key "k1" with body { amount: 10 }.
    const req1 = mockReq({ headers: { 'idempotency-key': 'k1' }, body: { amount: 10 } });
    const res1 = mockRes();
    const next1 = vi.fn();
    await mw(req1, res1, next1);
    res1.status(201).json({ data: { id: 's1' } });

    // Second request reuses "k1" but with a different body -> must conflict.
    const req2 = mockReq({ headers: { 'idempotency-key': 'k1' }, body: { amount: 999 } });
    const res2 = mockRes();
    const next2 = vi.fn();
    await mw(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(409);
    expect((res2.body as any).error).toBe('idempotency_conflict');
    expect(typeof (res2.body as any).stored_hash).toBe('string');
    expect(typeof (res2.body as any).incoming_hash).toBe('string');
    expect((res2.body as any).stored_hash).not.toBe((res2.body as any).incoming_hash);
    // The two bodies must hash differently (the root cause of the conflict).
    expect(hashBody({ amount: 10 })).not.toBe(hashBody({ amount: 999 }));
  });

  it('does not collide across different keys even with identical bodies', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware(store, 60);

    const req1 = mockReq({ headers: { 'idempotency-key': 'ka' }, body: { amount: 10 } });
    const res1 = mockRes();
    const next1 = vi.fn();
    await mw(req1, res1, next1);
    res1.status(201).json({ data: { id: 'sa' } });

    const req2 = mockReq({ headers: { 'idempotency-key': 'kb' }, body: { amount: 10 } });
    const res2 = mockRes();
    const next2 = vi.fn();
    await mw(req2, res2, next2);
    // Different key -> proceeds to the handler (next called), no 409.
    expect(next2).toHaveBeenCalledOnce();
  });
});
