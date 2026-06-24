import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { trace } from '@opentelemetry/api';
import {
  tracingMiddleware,
  extractStreamId,
  extractSenderAddress,
  extractRecipientAddress,
} from '../../../src/tracing/middleware.js';
import {
  enrichSpanWithStream,
  enrichActiveSpanWithStream,
  initializeTracer,
  resetTracer,
  Span,
} from '../../../src/tracing/hooks.js';

describe('Tracing Attributes Ingestion & Enrichment Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetTracer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTracer();
  });

  describe('Attribute Extraction Helpers', () => {
    it('extracts stream_id from headers, body, query, params, or path', () => {
      // 1. From X-Stream-Id header
      const reqHeader1 = {
        headers: { 'x-stream-id': 'stream-hdr-123' },
        body: {},
        query: {},
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqHeader1)).toBe('stream-hdr-123');

      // 2. From Stream-Id header
      const reqHeader2 = {
        headers: { 'stream-id': 'stream-hdr-456' },
        body: {},
        query: {},
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqHeader2)).toBe('stream-hdr-456');

      // 3. From fluxora-stream-id header
      const reqHeader3 = {
        headers: { 'fluxora-stream-id': 'stream-hdr-789' },
        body: {},
        query: {},
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqHeader3)).toBe('stream-hdr-789');

      // 4. From body (stream_id, streamId, id)
      const reqBody1 = {
        headers: {},
        body: { stream_id: 'stream-body-111' },
        query: {},
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqBody1)).toBe('stream-body-111');

      const reqBody2 = {
        headers: {},
        body: { streamId: 'stream-body-222' },
        query: {},
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqBody2)).toBe('stream-body-222');

      const reqBody3 = {
        headers: {},
        body: { id: 'stream-body-333' },
        query: {},
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqBody3)).toBe('stream-body-333');

      // 5. From query (stream_id, streamId, id)
      const reqQuery1 = {
        headers: {},
        body: {},
        query: { stream_id: 'stream-qry-111' },
        params: {},
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqQuery1)).toBe('stream-qry-111');

      // 6. From params (id, streamId)
      const reqParam1 = {
        headers: {},
        body: {},
        query: {},
        params: { id: 'stream-prm-123' },
        path: '/some/path',
      } as unknown as Request;
      expect(extractStreamId(reqParam1)).toBe('stream-prm-123');

      // 7. From path matching (/api/streams/:id)
      const reqPath1 = {
        headers: {},
        body: {},
        query: {},
        params: {},
        path: '/api/streams/stream-path-555',
      } as unknown as Request;
      expect(extractStreamId(reqPath1)).toBe('stream-path-555');

      const reqPath2 = {
        headers: {},
        body: {},
        query: {},
        params: {},
        path: '/api/streams/stream-path-777/status',
      } as unknown as Request;
      expect(extractStreamId(reqPath2)).toBe('stream-path-777');
    });

    it('extracts sender_address from headers, body, or query', () => {
      // Header
      const reqH = {
        headers: { 'x-sender-address': 'G-SENDER-HDR' },
      } as unknown as Request;
      expect(extractSenderAddress(reqH)).toBe('G-SENDER-HDR');

      // Body
      const reqB = {
        headers: {},
        body: { sender: 'G-SENDER-BODY' },
      } as unknown as Request;
      expect(extractSenderAddress(reqB)).toBe('G-SENDER-BODY');

      // Query
      const reqQ = {
        headers: {},
        body: {},
        query: { sender_address: 'G-SENDER-QRY' },
      } as unknown as Request;
      expect(extractSenderAddress(reqQ)).toBe('G-SENDER-QRY');
    });

    it('extracts recipient_address from headers, body, or query', () => {
      // Header
      const reqH = {
        headers: { 'x-recipient-address': 'G-RECIPIENT-HDR' },
      } as unknown as Request;
      expect(extractRecipientAddress(reqH)).toBe('G-RECIPIENT-HDR');

      // Body
      const reqB = {
        headers: {},
        body: { recipientAddress: 'G-RECIPIENT-BODY' },
      } as unknown as Request;
      expect(extractRecipientAddress(reqB)).toBe('G-RECIPIENT-BODY');

      // Query
      const reqQ = {
        headers: {},
        body: {},
        query: { recipient: 'G-RECIPIENT-QRY' },
      } as unknown as Request;
      expect(extractRecipientAddress(reqQ)).toBe('G-RECIPIENT-QRY');
    });

    it('returns undefined for missing or invalid attributes', () => {
      const emptyReq = {
        headers: {},
        body: {},
        query: {},
        params: {},
        path: '/api/streams/health',
      } as unknown as Request;

      expect(extractStreamId(emptyReq)).toBeUndefined();
      expect(extractSenderAddress(emptyReq)).toBeUndefined();
      expect(extractRecipientAddress(emptyReq)).toBeUndefined();
    });
  });

  describe('Tracing Middleware & OTel Enrichment', () => {
    it('sets stream attributes on active OTel span immediately if tracing enabled', async () => {
      const setAttributeSpy = vi.fn();
      const mockActiveSpan = {
        setAttribute: setAttributeSpy,
      };
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(mockActiveSpan as any);

      const req = {
        correlationId: 'corr-id-777',
        method: 'POST',
        path: '/api/streams',
        headers: {
          'x-stream-id': 'stream-test-999',
          'x-sender-address': 'G-SENDER-999',
          'x-recipient-address': 'G-REC-999',
        },
        body: {},
        query: {},
        params: {},
      } as unknown as Request;

      const res = {
        locals: {},
        on: vi.fn(),
      } as unknown as Response;

      const next = vi.fn() as NextFunction;

      // Enable tracing
      initializeTracer({ enabled: true });
      const mw = tracingMiddleware({ enabled: true });
      mw(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.stream_id', 'stream-test-999');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.sender', 'G-SENDER-999');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.recipient', 'G-REC-999');

      const traceContext = (res.locals as any).traceContext;
      expect(traceContext).toBeDefined();
      expect(traceContext.span.context.tags['fluxora.stream_id']).toBe('stream-test-999');
      expect(traceContext.span.context.tags['fluxora.sender']).toBe('G-SENDER-999');
      expect(traceContext.span.context.tags['fluxora.recipient']).toBe('G-REC-999');
    });

    it('performs deferred extraction on response finish hook', async () => {
      const setAttributeSpy = vi.fn();
      const mockActiveSpan = {
        setAttribute: setAttributeSpy,
      };
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(mockActiveSpan as any);

      const req = {
        correlationId: 'corr-id-888',
        method: 'PATCH',
        path: '/api/streams/stream-dynamic-111/status',
        headers: {},
        body: {},
        query: {},
        params: {},
      } as unknown as Request;

      let finishCallback: () => void = () => {};
      const res = {
        locals: {},
        statusCode: 200,
        getHeader: vi.fn(),
        on: vi.fn((event, cb) => {
          if (event === 'finish') finishCallback = cb;
        }),
      } as unknown as Response;

      const next = vi.fn() as NextFunction;

      initializeTracer({ enabled: true });
      const mw = tracingMiddleware({ enabled: true });
      mw(req, res, next);

      // On start, it should have extracted stream-dynamic-111 from path match
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.stream_id', 'stream-dynamic-111');

      // Now simulate a dynamically added body property in the route handler before finish
      req.body = {
        sender: 'G-SENDER-DYNAMIC',
        recipient: 'G-REC-DYNAMIC',
      };

      // Trigger finish
      finishCallback();

      // Should have re-extracted on finish and updated active span attributes
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.sender', 'G-SENDER-DYNAMIC');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.recipient', 'G-REC-DYNAMIC');

      const traceContext = (res.locals as any).traceContext;
      expect(traceContext.span.context.tags['fluxora.stream_id']).toBe('stream-dynamic-111');
      expect(traceContext.span.context.tags['fluxora.sender']).toBe('G-SENDER-DYNAMIC');
      expect(traceContext.span.context.tags['fluxora.recipient']).toBe('G-REC-DYNAMIC');
    });
  });

  describe('Span Helpers Enrichment', () => {
    it('enriches manual spans and active spans with enrichSpanWithStream', () => {
      const fakeSpan: Span = {
        context: {
          traceId: 'trace-manual',
          spanId: 'span-manual',
          tags: {},
        },
        startTimeMs: Date.now(),
        status: 'pending',
        events: [],
      };

      const setAttributeSpy = vi.fn();
      const mockActiveSpan = {
        setAttribute: setAttributeSpy,
      };
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(mockActiveSpan as any);

      enrichSpanWithStream(fakeSpan, 'str-manual', 'snd-manual', 'rec-manual');

      // Verify custom span tags
      expect(fakeSpan.context.tags!['fluxora.stream_id']).toBe('str-manual');
      expect(fakeSpan.context.tags!['fluxora.sender']).toBe('snd-manual');
      expect(fakeSpan.context.tags!['fluxora.recipient']).toBe('rec-manual');

      // Verify active OTel span attributes
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.stream_id', 'str-manual');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.sender', 'snd-manual');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.recipient', 'rec-manual');
    });

    it('enriches internal OTel spans associated with custom tracer spans', () => {
      const otelSpanAttributeSpy = vi.fn();
      const mockOtelSpan = {
        setAttribute: otelSpanAttributeSpy,
      };

      const fakeSpan: Span = {
        context: {
          traceId: 'trace-manual',
          spanId: 'span-manual',
          tags: {
            _otelSpan: mockOtelSpan,
          },
        },
        startTimeMs: Date.now(),
        status: 'pending',
        events: [],
      };

      enrichSpanWithStream(fakeSpan, 'str-associated', 'snd-associated');

      expect(otelSpanAttributeSpy).toHaveBeenCalledWith('fluxora.stream_id', 'str-associated');
      expect(otelSpanAttributeSpy).toHaveBeenCalledWith('fluxora.sender', 'snd-associated');
    });

    it('enriches active span only with enrichActiveSpanWithStream', () => {
      const setAttributeSpy = vi.fn();
      const mockActiveSpan = {
        setAttribute: setAttributeSpy,
      };
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(mockActiveSpan as any);

      enrichActiveSpanWithStream('str-active-only', 'snd-active-only', 'rec-active-only');

      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.stream_id', 'str-active-only');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.sender', 'snd-active-only');
      expect(setAttributeSpy).toHaveBeenCalledWith('fluxora.recipient', 'rec-active-only');
    });

    it('handles null values and missing contexts gracefully without throwing', () => {
      expect(() => {
        enrichSpanWithStream(null as any, 'str', 'snd');
        enrichSpanWithStream({} as any, 'str', 'snd');
        enrichActiveSpanWithStream(undefined, undefined, undefined);
      }).not.toThrow();
    });
  });
});
