/**
 * Tests for OTel span instrumentation across HTTP, DB, Stellar RPC,
 * webhook dispatch, and WS broadcast, plus correlationId propagation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Response, NextFunction } from 'express';
import request from 'supertest';
import {
  initializeTracer,
  resetTracer,
  getTracer,
  traceSpan,
  traceSseDispatch,
} from '../../src/tracing/hooks.js';
import {
  _resetSseSubscriptionsForTest,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
  subscribeToSseStream,
} from '../../src/streams/sseEmitter.js';
import {
  tracingMiddleware,
  getCorrelationId,
  correlationStore,
} from '../../src/tracing/middleware.js';
import { SpanBuffer } from '../../src/tracing/builtin.js';

// ── traceSpan helper ──────────────────────────────────────────────────────────

describe('traceSpan helper', () => {
  beforeEach(() => {
    resetTracer();
    initializeTracer({ enabled: true });
  });

  it('creates a span, runs fn, ends span ok on success', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    const result = await traceSpan('test.op', 'corr-1', { 'test.tag': 'v' }, async () => 42);

    expect(result).toBe(42);
    const spans = buffer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].context.traceId).toBe('corr-1');
    expect(spans[0].context.tags?.['span.name']).toBe('test.op');
    expect(spans[0].context.tags?.['test.tag']).toBe('v');
    expect(spans[0].status).toBe('ok');
  });

  it('ends span with error status and re-throws on failure', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await expect(
      traceSpan('test.op', 'corr-2', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const spans = buffer.getSpans();
    expect(spans[0].status).toBe('error');
    expect(spans[0].statusMessage).toBe('boom');
  });

  it('passes the span to fn so callers can record extra events', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await traceSpan('test.op', 'corr-3', {}, async (span) => {
      getTracer().recordEvent(span, 'custom.event', { x: 1 });
    });

    const spans = buffer.getSpans();
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe('custom.event');
  });

  it('is a no-op when tracing is disabled', async () => {
    resetTracer();
    initializeTracer({ enabled: false });

    const result = await traceSpan('test.op', 'corr-4', {}, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('records SSE dispatch spans and closes them when a subscriber throws', () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    expect(() => {
      traceSseDispatch('stream-123', 'evt-1', 2, 'corr-sse', () => {
        throw new Error('client write failed');
      });
    }).toThrow('client write failed');

    const spans = buffer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('error');
    expect(spans[0].statusMessage).toBe('client write failed');
    expect(spans[0].context.traceId).toBe('corr-sse');
    expect(spans[0].context.tags?.['span.name']).toBe('sse.dispatch');
    expect(spans[0].context.tags?.['sse.subscribers']).toBe(2);
  });

  it('closes an ok SSE dispatch span when fan-out isolates a failing subscriber', () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });
    _resetSseSubscriptionsForTest();

    const unsubscribeFailing = subscribeToSseStream('stream-123', () => {
      throw new Error('client write failed');
    });
    const delivered = vi.fn();
    const unsubscribeHealthy = subscribeToSseStream('stream-123', delivered);

    try {
      sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, {
        streamId: 'stream-123',
        eventId: 'evt-2',
        payload: { status: 'active' },
        correlationId: 'corr-sse',
      });

      expect(delivered).toHaveBeenCalledOnce();
      const spans = buffer.getSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toBe('ok');
      expect(spans[0].context.traceId).toBe('corr-sse');
      expect(spans[0].events[0]?.name).toBe('sse.dispatch');
    } finally {
      unsubscribeFailing();
      unsubscribeHealthy();
      _resetSseSubscriptionsForTest();
    }
  });
});

// ── correlationId propagation ─────────────────────────────────────────────────

describe('correlationId propagation via AsyncLocalStorage', () => {
  it('getCorrelationId returns "unknown" outside a request context', () => {
    expect(getCorrelationId()).toBe('unknown');
  });

  it('getCorrelationId returns the stored value inside correlationStore.run()', async () => {
    let captured = '';
    await correlationStore.run('req-abc', async () => {
      captured = getCorrelationId();
    });
    expect(captured).toBe('req-abc');
  });

  it('propagates through nested async calls', async () => {
    const results: string[] = [];

    await correlationStore.run('req-xyz', async () => {
      results.push(getCorrelationId());
      await Promise.resolve();
      results.push(getCorrelationId());
      await new Promise<void>((resolve) => setTimeout(() => {
        results.push(getCorrelationId());
        resolve();
      }, 0));
    });

    expect(results).toEqual(['req-xyz', 'req-xyz', 'req-xyz']);
  });

  it('tracingMiddleware propagates correlationId even when tracing is disabled', async () => {
    resetTracer();
    initializeTracer({ enabled: false });

    const app = express();
    app.use((req: any, _res: Response, next: NextFunction) => {
      req.correlationId = 'disabled-corr';
      next();
    });
    app.use(tracingMiddleware({ enabled: false }));
    app.get('/test', (_req, res) => {
      res.json({ correlationId: getCorrelationId() });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('disabled-corr');
  });

  it('tracingMiddleware propagates correlationId when tracing is enabled', async () => {
    resetTracer();
    initializeTracer({ enabled: true });

    const app = express();
    app.use((req: any, _res: Response, next: NextFunction) => {
      req.correlationId = 'enabled-corr';
      next();
    });
    app.use(tracingMiddleware({ enabled: true }));
    app.get('/test', (_req, res) => {
      res.json({ correlationId: getCorrelationId() });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('enabled-corr');
  });
});

// ── db.query span ─────────────────────────────────────────────────────────────

describe('db.query span', () => {
  it('emits a db.query span with db.sql tag', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    // Run inside a correlationStore context so getCorrelationId() works
    await correlationStore.run('db-corr', async () => {
      await traceSpan('db.query', getCorrelationId(), { 'db.sql': 'SELECT 1' }, async () => {});
    });

    const spans = buffer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].context.tags?.['span.name']).toBe('db.query');
    expect(spans[0].context.tags?.['db.sql']).toBe('SELECT 1');
    expect(spans[0].context.traceId).toBe('db-corr');
  });

  it('marks span as error when query throws', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await correlationStore.run('db-err', async () => {
      await expect(
        traceSpan('db.query', getCorrelationId(), { 'db.sql': 'BAD SQL' }, async () => {
          throw new Error('syntax error');
        }),
      ).rejects.toThrow('syntax error');
    });

    const spans = buffer.getSpans();
    expect(spans[0].status).toBe('error');
  });
});

// ── stellar.rpc span ──────────────────────────────────────────────────────────

describe('stellar.rpc span', () => {
  it('emits a stellar.rpc span with rpc.operation tag', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await correlationStore.run('rpc-corr', async () => {
      await traceSpan(
        'stellar.rpc',
        getCorrelationId(),
        { 'rpc.operation': 'getLatestLedger' },
        async () => ({ sequence: 100 }),
      );
    });

    const spans = buffer.getSpans();
    expect(spans[0].context.tags?.['span.name']).toBe('stellar.rpc');
    expect(spans[0].context.tags?.['rpc.operation']).toBe('getLatestLedger');
    expect(spans[0].status).toBe('ok');
  });

  it('marks span as error when RPC throws', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await correlationStore.run('rpc-err', async () => {
      await expect(
        traceSpan('stellar.rpc', getCorrelationId(), { 'rpc.operation': 'getLatestLedger' }, async () => {
          throw new Error('circuit open');
        }),
      ).rejects.toThrow('circuit open');
    });

    const spans = buffer.getSpans();
    expect(spans[0].status).toBe('error');
  });
});

// ── webhook.dispatch span ─────────────────────────────────────────────────────

describe('webhook.dispatch span', () => {
  it('emits a webhook.dispatch span with event, url, and retry tags', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await correlationStore.run('wh-corr', async () => {
      await traceSpan(
        'webhook.dispatch',
        getCorrelationId(),
        { 'webhook.event': 'stream.created', 'webhook.url': 'https://example.com/hook', 'webhook.retry': 0 },
        async () => {},
      );
    });

    const spans = buffer.getSpans();
    expect(spans[0].context.tags?.['span.name']).toBe('webhook.dispatch');
    expect(spans[0].context.tags?.['webhook.event']).toBe('stream.created');
    expect(spans[0].context.tags?.['webhook.url']).toBe('https://example.com/hook');
    expect(spans[0].context.tags?.['webhook.retry']).toBe(0);
    expect(spans[0].status).toBe('ok');
  });

  it('marks span as error when dispatch throws', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    await correlationStore.run('wh-err', async () => {
      await expect(
        traceSpan('webhook.dispatch', getCorrelationId(), { 'webhook.event': 'stream.created', 'webhook.url': 'x', 'webhook.retry': 3 }, async () => {
          throw new Error('network error');
        }),
      ).rejects.toThrow('network error');
    });

    const spans = buffer.getSpans();
    expect(spans[0].status).toBe('error');
  });
});

// ── ws.broadcast span ─────────────────────────────────────────────────────────

describe('ws.broadcast span', () => {
  it('emits a ws.broadcast span event with streamId, eventId, and recipients', async () => {
    const buffer = new SpanBuffer({ logEvents: false });
    resetTracer();
    initializeTracer({ enabled: true, hooks: buffer });

    // Simulate what hub.broadcast() does
    const tracer = getTracer();
    const span = tracer.startSpan({
      traceId: 'evt-123',
      serviceName: 'fluxora-ws',
      tags: { 'ws.stream_id': 'stream-1', 'ws.event_id': 'evt-123', 'ws.recipients': 3 },
    });
    tracer.recordEvent(span, 'ws.broadcast', { streamId: 'stream-1', eventId: 'evt-123', recipients: 3 });
    tracer.endSpan(span, 'ok');

    const spans = buffer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].context.tags?.['ws.stream_id']).toBe('stream-1');
    expect(spans[0].context.tags?.['ws.recipients']).toBe(3);
    expect(spans[0].events[0].name).toBe('ws.broadcast');
    expect(spans[0].events[0].attributes?.recipients).toBe(3);
    expect(spans[0].status).toBe('ok');
  });
});
