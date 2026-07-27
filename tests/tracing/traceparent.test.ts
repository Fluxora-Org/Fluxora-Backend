/**
 * tests/tracing/traceparent.test.ts
 *
 * Comprehensive tests for W3C traceparent header propagation (issue #756).
 *
 * Coverage:
 *  - parseTraceparent: valid inputs, all invalid inputs, edge cases
 *  - buildTraceparent: correct format output
 *  - tracingMiddleware: inbound header parsing, traceId adoption
 *  - traceContextStore: populated when traceparent is valid/absent
 *  - getActiveTraceContext: returns correct value in async scope
 *  - Webhook dispatcher: outbound traceparent header attached
 *  - Stellar RPC accountExists: outbound traceparent header attached
 *  - No existing correlation-id behaviour is broken
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import {
  parseTraceparent,
  buildTraceparent,
  getActiveTraceContext,
  traceContextStore,
  correlationStore,
  tracingMiddleware,
  type TraceparentFields,
} from '../../src/tracing/middleware.js';
import { initializeTracer, resetTracer } from '../../src/tracing/hooks.js';

// ── parseTraceparent ──────────────────────────────────────────────────────────

describe('parseTraceparent', () => {
  const VALID_TRACE_ID = 'a'.repeat(32);
  const VALID_PARENT_ID = 'b'.repeat(16);

  it('parses a well-formed version-00 traceparent', () => {
    const result = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_PARENT_ID}-01`);
    expect(result).not.toBeNull();
    expect(result!.version).toBe('00');
    expect(result!.traceId).toBe(VALID_TRACE_ID);
    expect(result!.parentId).toBe(VALID_PARENT_ID);
    expect(result!.flags).toBe('01');
    expect(result!.sampled).toBe(true);
  });

  it('parses sampled flag = false (flags 00)', () => {
    const result = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_PARENT_ID}-00`);
    expect(result).not.toBeNull();
    expect(result!.sampled).toBe(false);
  });

  it('parses flags where bit 0 is not set but other bits are set (e.g. 02)', () => {
    const result = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_PARENT_ID}-02`);
    expect(result).not.toBeNull();
    expect(result!.sampled).toBe(false);
  });

  it('accepts upper-case hex (normalises to lower)', () => {
    const upper = `00-${VALID_TRACE_ID.toUpperCase()}-${VALID_PARENT_ID.toUpperCase()}-01`;
    const result = parseTraceparent(upper);
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe(VALID_TRACE_ID.toLowerCase());
  });

  it('parses a realistic traceparent from an upstream service', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const result = parseTraceparent(tp);
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(result!.parentId).toBe('00f067aa0ba902b7');
    expect(result!.sampled).toBe(true);
  });

  // ── Invalid inputs ────────────────────────────────────────────────────────

  it('returns null for undefined', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseTraceparent(null)).toBeNull();
  });

  it('returns null for a number', () => {
    expect(parseTraceparent(42)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseTraceparent('')).toBeNull();
  });

  it('returns null when traceId is all zeros (invalid per spec §2.2.4)', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${VALID_PARENT_ID}-01`)).toBeNull();
  });

  it('returns null when parentId is all zeros (invalid per spec §2.2.5)', () => {
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('returns null for reserved version ff', () => {
    expect(parseTraceparent(`ff-${VALID_TRACE_ID}-${VALID_PARENT_ID}-01`)).toBeNull();
  });

  it('returns null when traceId is too short (31 chars)', () => {
    expect(parseTraceparent(`00-${'a'.repeat(31)}-${VALID_PARENT_ID}-01`)).toBeNull();
  });

  it('returns null when traceId is too long (33 chars)', () => {
    expect(parseTraceparent(`00-${'a'.repeat(33)}-${VALID_PARENT_ID}-01`)).toBeNull();
  });

  it('returns null when parentId is too short (15 chars)', () => {
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${'b'.repeat(15)}-01`)).toBeNull();
  });

  it('returns null when parentId is too long (17 chars)', () => {
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${'b'.repeat(17)}-01`)).toBeNull();
  });

  it('returns null for a non-hex traceId character', () => {
    const bad = `00-${'g'.repeat(32)}-${VALID_PARENT_ID}-01`;
    expect(parseTraceparent(bad)).toBeNull();
  });

  it('returns null when missing dashes', () => {
    expect(parseTraceparent(`00${VALID_TRACE_ID}${VALID_PARENT_ID}01`)).toBeNull();
  });

  it('returns null when the header exceeds MAX_TRACEPARENT_LENGTH (200 chars)', () => {
    expect(parseTraceparent('x'.repeat(201))).toBeNull();
  });

  it('returns null for a string with extra trailing content', () => {
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_PARENT_ID}-01-extra`)).toBeNull();
  });

  it('strips surrounding whitespace before validating', () => {
    const padded = `  00-${VALID_TRACE_ID}-${VALID_PARENT_ID}-01  `;
    const result = parseTraceparent(padded);
    expect(result).not.toBeNull();
  });
});

// ── buildTraceparent ──────────────────────────────────────────────────────────

describe('buildTraceparent', () => {
  const TRACE_ID = 'a'.repeat(32);
  const PARENT_ID = 'b'.repeat(16);

  it('builds a sampled traceparent (flags 01)', () => {
    expect(buildTraceparent(TRACE_ID, PARENT_ID, true))
      .toBe(`00-${TRACE_ID}-${PARENT_ID}-01`);
  });

  it('builds an unsampled traceparent (flags 00)', () => {
    expect(buildTraceparent(TRACE_ID, PARENT_ID, false))
      .toBe(`00-${TRACE_ID}-${PARENT_ID}-00`);
  });

  it('defaults sampled=true when omitted', () => {
    expect(buildTraceparent(TRACE_ID, PARENT_ID))
      .toBe(`00-${TRACE_ID}-${PARENT_ID}-01`);
  });

  it('round-trips: parse(build(…)) yields the original fields', () => {
    const built = buildTraceparent(TRACE_ID, PARENT_ID, true);
    const parsed = parseTraceparent(built);
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(TRACE_ID);
    expect(parsed!.parentId).toBe(PARENT_ID);
    expect(parsed!.sampled).toBe(true);
  });
});

// ── getActiveTraceContext ─────────────────────────────────────────────────────

describe('getActiveTraceContext', () => {
  it('returns null outside any async context', () => {
    expect(getActiveTraceContext()).toBeNull();
  });

  it('returns the trace context stored in the current async scope', () => {
    const ctx: TraceparentFields = {
      version: '00',
      traceId: 'a'.repeat(32),
      parentId: 'b'.repeat(16),
      flags: '01',
      sampled: true,
    };
    traceContextStore.run(ctx, () => {
      expect(getActiveTraceContext()).toEqual(ctx);
    });
  });

  it('returns null when the store was explicitly set to null', () => {
    traceContextStore.run(null, () => {
      expect(getActiveTraceContext()).toBeNull();
    });
  });
});

// ── tracingMiddleware: inbound traceparent propagation ────────────────────────

function buildApp(tracingEnabled: boolean = true) {
  const app = express();

  app.use((req: any, _res: Response, next: NextFunction) => {
    req.correlationId = req.headers['x-correlation-id'] ?? 'fallback-corr-id';
    next();
  });

  resetTracer();
  initializeTracer({ enabled: tracingEnabled });
  app.use(tracingMiddleware({ enabled: tracingEnabled }));

  return app;
}

describe('tracingMiddleware — inbound traceparent', () => {
  it('stores the parsed traceparent in traceContextStore when valid header present', async () => {
    const app = buildApp(true);
    const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
    const PARENT_ID = '00f067aa0ba902b7';
    const tp = `00-${TRACE_ID}-${PARENT_ID}-01`;

    app.get('/probe', (_req: Request, res: Response) => {
      const ctx = getActiveTraceContext();
      res.json({ traceId: ctx?.traceId ?? null, parentId: ctx?.parentId ?? null, sampled: ctx?.sampled ?? null });
    });

    const res = await request(app)
      .get('/probe')
      .set('traceparent', tp);

    expect(res.status).toBe(200);
    expect(res.body.traceId).toBe(TRACE_ID);
    expect(res.body.parentId).toBe(PARENT_ID);
    expect(res.body.sampled).toBe(true);
  });

  it('uses upstream traceId as span traceId when valid traceparent is present', async () => {
    const app = buildApp(true);
    const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
    const PARENT_ID = '00f067aa0ba902b7';
    const tp = `00-${TRACE_ID}-${PARENT_ID}-01`;

    let capturedTraceId: string | undefined;
    app.get('/probe', (_req: Request, res: Response) => {
      // traceContext.span.context.traceId should equal the upstream traceId
      const tc = (res.locals as any).traceContext;
      capturedTraceId = tc?.span?.context?.traceId;
      res.json({ ok: true });
    });

    await request(app).get('/probe').set('traceparent', tp);
    expect(capturedTraceId).toBe(TRACE_ID);
  });

  it('falls back to correlationId when no traceparent header is present', async () => {
    const app = buildApp(true);
    let capturedTraceId: string | undefined;

    app.get('/probe', (_req: Request, res: Response) => {
      const tc = (res.locals as any).traceContext;
      capturedTraceId = tc?.span?.context?.traceId;
      res.json({ ok: true });
    });

    await request(app).get('/probe').set('x-correlation-id', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(capturedTraceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('falls back to correlationId when traceparent is malformed', async () => {
    const app = buildApp(true);
    let capturedTraceId: string | undefined;

    app.get('/probe', (_req: Request, res: Response) => {
      const tc = (res.locals as any).traceContext;
      capturedTraceId = tc?.span?.context?.traceId;
      res.json({ ok: true });
    });

    await request(app)
      .get('/probe')
      .set('traceparent', 'not-valid-at-all')
      .set('x-correlation-id', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

    expect(capturedTraceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('sets traceContextStore to null when no traceparent present', async () => {
    const app = buildApp(true);
    let ctx: TraceparentFields | null = undefined as any;

    app.get('/probe', (_req: Request, res: Response) => {
      ctx = getActiveTraceContext();
      res.json({ ok: true });
    });

    await request(app).get('/probe');
    expect(ctx).toBeNull();
  });

  it('does not break existing requests (no traceparent → 200 OK)', async () => {
    const app = buildApp(true);
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('propagates traceContext store even when tracing is disabled', async () => {
    const app = buildApp(false);
    const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
    const PARENT_ID = '00f067aa0ba902b7';
    const tp = `00-${TRACE_ID}-${PARENT_ID}-01`;
    let ctx: TraceparentFields | null = null;

    app.get('/probe', (_req: Request, res: Response) => {
      ctx = getActiveTraceContext();
      res.json({ ok: true });
    });

    await request(app).get('/probe').set('traceparent', tp);
    // Even when tracing is disabled the store should be populated for
    // outbound header propagation to work.
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe(TRACE_ID);
  });

  it('records upstream parentId in span.context.parentSpanId', async () => {
    const app = buildApp(true);
    const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
    const PARENT_ID = '00f067aa0ba902b7';
    const tp = `00-${TRACE_ID}-${PARENT_ID}-01`;
    let parentSpanId: string | undefined;

    app.get('/probe', (_req: Request, res: Response) => {
      const tc = (res.locals as any).traceContext;
      parentSpanId = tc?.span?.context?.parentSpanId;
      res.json({ ok: true });
    });

    await request(app).get('/probe').set('traceparent', tp);
    expect(parentSpanId).toBe(PARENT_ID);
  });

  it('records traceparent metadata in span tags', async () => {
    const app = buildApp(true);
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    let tags: Record<string, unknown> | undefined;

    app.get('/probe', (_req: Request, res: Response) => {
      const tc = (res.locals as any).traceContext;
      tags = tc?.span?.context?.tags;
      res.json({ ok: true });
    });

    await request(app).get('/probe').set('traceparent', tp);
    expect(tags?.['traceparent.version']).toBe('00');
    expect(tags?.['traceparent.sampled']).toBe(true);
  });
});

// ── Webhook dispatcher outbound traceparent ───────────────────────────────────

describe('WebhookDispatcher — outbound traceparent header', () => {
  it('attaches traceparent header when active trace context exists', async () => {
    const { WebhookDispatcher } = await import('../../src/webhooks/dispatcher.js');

    const capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) Object.assign(capturedHeaders, headers);
      return new Response(null, { status: 200 });
    });

    const mockStore = {
      checkAndClaimAttempt: vi.fn().mockResolvedValue({ allowed: true, state: 'CLOSED' }),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue({ consecutiveFailures: 0 }),
      getState: vi.fn().mockResolvedValue(null),
    };

    const dispatcher = new WebhookDispatcher(
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, timeoutMs: 5000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 60000 } as any,
      mockStore as any,
    );

    const ctx: TraceparentFields = {
      version: '00',
      traceId: 'a'.repeat(32),
      parentId: 'b'.repeat(16),
      flags: '01',
      sampled: true,
    };

    await traceContextStore.runPromise(ctx, () =>
      dispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'test-secret',
        payload: JSON.stringify({ event: 'test' }),
        deliveryId: 'del-123',
        eventType: 'stream.created',
        attemptNumber: 1,
      })
    );

    expect(capturedHeaders['traceparent']).toBe(
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
    );

    fetchSpy.mockRestore();
  });

  it('does not attach traceparent header when no trace context exists', async () => {
    const { WebhookDispatcher } = await import('../../src/webhooks/dispatcher.js');

    const capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) Object.assign(capturedHeaders, headers);
      return new Response(null, { status: 200 });
    });

    const mockStore = {
      checkAndClaimAttempt: vi.fn().mockResolvedValue({ allowed: true, state: 'CLOSED' }),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue({ consecutiveFailures: 0 }),
      getState: vi.fn().mockResolvedValue(null),
    };

    const dispatcher = new WebhookDispatcher(
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, timeoutMs: 5000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 60000 } as any,
      mockStore as any,
    );

    // No traceContextStore.run — so getActiveTraceContext() returns null
    await dispatcher.dispatch({
      url: 'https://example.com/webhook',
      secret: 'test-secret',
      payload: JSON.stringify({ event: 'test' }),
      deliveryId: 'del-456',
      eventType: 'stream.cancelled',
      attemptNumber: 1,
    });

    expect(capturedHeaders['traceparent']).toBeUndefined();

    fetchSpy.mockRestore();
  });
});

// ── Stellar RPC outbound traceparent ──────────────────────────────────────────

describe('StellarRpcService.accountExists — outbound traceparent header', () => {
  it('attaches traceparent to Horizon fetch when active trace context exists', async () => {
    const { StellarRpcService } = await import('../../src/services/stellar-rpc.js');

    const capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      if (h) Object.assign(capturedHeaders, h);
      return new Response(null, { status: 200 });
    });

    const svc = new StellarRpcService(
      () => ({ getLatestLedger: async () => ({ sequence: 1 }), horizonUrl: 'https://horizon.example.com' }),
    );

    const ctx: TraceparentFields = {
      version: '00',
      traceId: 'c'.repeat(32),
      parentId: 'd'.repeat(16),
      flags: '01',
      sampled: true,
    };

    await traceContextStore.runPromise(ctx, () =>
      svc.accountExists('GABCDEFG', {})
    );

    expect(capturedHeaders['traceparent']).toBe(
      `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`
    );

    fetchSpy.mockRestore();
  });

  it('does not attach traceparent when no active trace context', async () => {
    const { StellarRpcService } = await import('../../src/services/stellar-rpc.js');

    const capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      if (h) Object.assign(capturedHeaders, h);
      return new Response(null, { status: 200 });
    });

    const svc = new StellarRpcService(
      () => ({ getLatestLedger: async () => ({ sequence: 1 }), horizonUrl: 'https://horizon.example.com' }),
    );

    await svc.accountExists('GABCDEFG', {});

    expect(capturedHeaders['traceparent']).toBeUndefined();

    fetchSpy.mockRestore();
  });
});

// ── AsyncLocalStorage helper (runPromise polyfill for tests) ─────────────────
// Node 18 AsyncLocalStorage doesn't expose `.runPromise`, so we extend it here
// for test convenience.
declare module 'async_hooks' {
  interface AsyncLocalStorage<T> {
    runPromise<R>(value: T, fn: () => Promise<R>): Promise<R>;
  }
}
if (!traceContextStore.runPromise) {
  (traceContextStore as any).runPromise = function<T, R>(
    this: typeof traceContextStore,
    value: T,
    fn: () => Promise<R>,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      (this as any).run(value, () => fn().then(resolve, reject));
    });
  };
}
