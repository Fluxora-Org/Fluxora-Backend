import http from 'http';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';
import { vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../src/ws/messageHandler', () => ({
  isValidStellarPublicKey: (value: string) => value.startsWith('G'),
  parseHandshakeSubscriptionFilter: () => ({ ok: true, filter: null }),
  parseWsClientMessage: (message: { type?: string; streamId?: string; stream_id?: string }) => {
    if (message.type === 'subscribe' || message.type === 'unsubscribe') {
      return {
        ok: true,
        message: {
          type: message.type,
          filter: { streamId: message.streamId ?? message.stream_id },
        },
      };
    }

    return { ok: false, code: 'UNKNOWN_TYPE', message: `Unknown message type: ${message.type}` };
  },
}));

import {
  correlationIdMiddleware,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  isValidCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
} from '../src/middleware/correlationId';
import { correlationStore, getCorrelationId } from '../src/tracing/middleware';
import { StreamHub } from '../src/ws/hub';
import { webhookDispatcher } from '../src/webhooks/dispatcher';
import { logger } from '../src/lib/logger.js';

function createCorrelationIdTestApp() {
  const app = express();

  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.get('/', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/streams', (_req, res) => res.json({ streams: [] }));
  app.post('/api/streams', (_req, res) => res.status(201).json({ ok: true }));

  return app;
}

const app = createCorrelationIdTestApp();

describe('correlationId middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ID generation', () => {
    it('generates a correlation ID when none is provided', async () => {
      const res = await request(app).get('/health');
      const id = res.headers[CORRELATION_ID_HEADER];
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect((id as string).length).toBeGreaterThan(0);
    });

    it('generated ID looks like a UUID v4', async () => {
      const res = await request(app).get('/health');
      const id = res.headers[CORRELATION_ID_HEADER] as string;
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a unique ID for each request', async () => {
      const [r1, r2] = await Promise.all([
        request(app).get('/health'),
        request(app).get('/health'),
      ]);
      expect(r1.headers[CORRELATION_ID_HEADER]).not.toBe(r2.headers[CORRELATION_ID_HEADER]);
    });
  });

  describe('ID propagation', () => {
    it('reuses the incoming x-correlation-id header', async () => {
      // The middleware only honours valid UUIDv4 values.
      const clientId = '11111111-1111-4111-8111-111111111111';
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(clientId);
    });

    it('rejects whitespace-padded values exceeding max raw length', () => {
      // Raw length (incl. whitespace) > 36 → rejected by raw-length gate before trim.
      // Uses direct middleware call because supertest/Express may trim HTTP headers.
      const padded = '  22222222-2222-4222-8222-222222222222  ';
      const req = { headers: { [CORRELATION_ID_HEADER]: padded } } as any;
      const res = { setHeader: vi.fn() } as any;

      correlationIdMiddleware(req, res, () => {
        expect(req.correlationId).not.toBe(padded);
        expect(req.correlationId).not.toBe('22222222-2222-4222-8222-222222222222');
        expect(isValidCorrelationId(req.correlationId)).toBe(true);
      });
    });

    it('generates a new ID when incoming header is an empty string', async () => {
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, '');
      const id = res.headers[CORRELATION_ID_HEADER] as string;
      expect(id.length).toBeGreaterThan(0);
    });

    it('generates a new ID when incoming header is only whitespace', async () => {
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, '   ');
      const id = res.headers[CORRELATION_ID_HEADER] as string;
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a new ID when incoming header is malformed', async () => {
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, 'not-a-uuid');
      const id = res.headers[CORRELATION_ID_HEADER] as string;
      expect(id).not.toBe('not-a-uuid');
      expect(isValidCorrelationId(id)).toBe(true);
    });

    it('rejects oversized inbound correlation IDs at unit level', () => {
      const oversized = '1'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
      expect(isValidCorrelationId(oversized)).toBe(false);
    });

    it('rejects oversized raw value via middleware (raw length > 36)', async () => {
      const oversized = '1'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, oversized);
      const id = res.headers[CORRELATION_ID_HEADER] as string;
      expect(id).not.toBe(oversized);
      expect(isValidCorrelationId(id)).toBe(true);
    });

    it('rejects control-character-bearing inbound within 36-char limit (charset reject)', () => {
      // Raw length is exactly 36 so raw-length gate passes; charset gate catches the \t.
      const withTab = '11111111-1111-4111-\t111-111111111111';
      const req = { headers: { [CORRELATION_ID_HEADER]: withTab } } as any;
      const res = { setHeader: vi.fn() } as any;

      correlationIdMiddleware(req, res, () => {
        expect(req.correlationId).not.toBe(withTab);
        expect(req.correlationId).not.toContain('\t');
        expect(isValidCorrelationId(req.correlationId)).toBe(true);
      });
    });

    it('rejects control-character-only inbound', () => {
      const ctrlOnly = '\x00\x01\x02';
      const req = { headers: { [CORRELATION_ID_HEADER]: ctrlOnly } } as any;
      const res = { setHeader: vi.fn() } as any;

      correlationIdMiddleware(req, res, () => {
        expect(req.correlationId).not.toBe(ctrlOnly);
        expect(isValidCorrelationId(req.correlationId)).toBe(true);
      });
    });

    it('rejection logs the fact but never the raw value (oversized)', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const oversized = '1'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
      const req = { headers: { [CORRELATION_ID_HEADER]: oversized } } as any;
      const res = { setHeader: vi.fn() } as any;

      correlationIdMiddleware(req, res, () => {
        expect(warnSpy).toHaveBeenCalledWith(
          'Correlation ID rejected (oversized raw length), generating new ID',
        );
      });
    });

    it('rejection logs the fact but never the raw value (invalid format)', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const malformed = 'not-a-valid-uuid';
      const req = { headers: { [CORRELATION_ID_HEADER]: malformed } } as any;
      const res = { setHeader: vi.fn() } as any;

      correlationIdMiddleware(req, res, () => {
        expect(warnSpy).toHaveBeenCalledWith(
          'Correlation ID rejected (invalid format), generating new ID',
        );
      });
    });

    it('does not log a warning for missing or empty headers', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      // Missing header
      const req1 = { headers: {} } as any;
      const res1 = { setHeader: vi.fn() } as any;
      correlationIdMiddleware(req1, res1, () => {
        expect(warnSpy).not.toHaveBeenCalled();
        expect(isValidCorrelationId(req1.correlationId)).toBe(true);
      });

      // Empty header
      const req2 = { headers: { [CORRELATION_ID_HEADER]: '' } } as any;
      const res2 = { setHeader: vi.fn() } as any;
      correlationIdMiddleware(req2, res2, () => {
        expect(warnSpy).not.toHaveBeenCalled();
        expect(isValidCorrelationId(req2.correlationId)).toBe(true);
      });
    });

    it('regenerates oversized control-character-bearing inbound IDs', () => {
      // Raw length > 36: caught by the raw-length gate.
      const maliciousId = '11111111-1111-4111-8111-111111111111\nlog=forged';
      const req = { headers: { [CORRELATION_ID_HEADER]: maliciousId } } as any;
      const res = { setHeader: vi.fn() } as any;

      correlationIdMiddleware(req, res, () => {
        expect(req.correlationId).not.toBe(maliciousId);
        expect(req.correlationId).not.toContain('\n');
        expect(isValidCorrelationId(req.correlationId)).toBe(true);
      });
    });
  });

  describe('header on every route', () => {
    it('sets correlation ID on GET /', async () => {
      const res = await request(app).get('/');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });

    it('sets correlation ID on GET /health', async () => {
      const res = await request(app).get('/health');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });

    it('sets correlation ID on GET /api/streams', async () => {
      const res = await request(app).get('/api/streams');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });

    it('sets correlation ID on POST /api/streams', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Idempotency-Key', 'correlation-id-post-test')
        .send({ sender: 'A', recipient: 'B', depositAmount: '100', ratePerSecond: '1', startTime: 0 });
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });
  });

  describe('X-Request-ID header', () => {
    it('sets X-Request-ID on a success (200) response', async () => {
      const res = await request(app).get('/health');
      expect(res.headers[REQUEST_ID_HEADER]).toBeDefined();
      expect(typeof res.headers[REQUEST_ID_HEADER]).toBe('string');
    });

    it('X-Request-ID matches x-correlation-id on success responses', async () => {
      const res = await request(app).get('/');
      expect(res.headers[REQUEST_ID_HEADER]).toBe(res.headers[CORRELATION_ID_HEADER]);
    });

    it('X-Request-ID matches provided x-correlation-id when valid', async () => {
      const clientId = 'aaaaaaaa-bbbb-4bbb-8bbb-cccccccccccc';
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);
      expect(res.headers[REQUEST_ID_HEADER]).toBe(clientId);
      expect(res.headers[REQUEST_ID_HEADER]).toBe(res.headers[CORRELATION_ID_HEADER]);
    });

    it('X-Request-ID is a valid UUID when inbound header is rejected', async () => {
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, 'bad-id');
      expect(isValidCorrelationId(res.headers[REQUEST_ID_HEADER] as string)).toBe(true);
    });

    it('middleware sets X-Request-ID synchronously via setHeader', () => {
      const req = { headers: {} } as any;
      const setHeader = vi.fn();
      const res = { setHeader } as any;

      correlationIdMiddleware(req, res, () => {
        expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, req.correlationId);
        expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, req.correlationId);
      });
    });
  });
});

describe('correlation ID propagation across transports', () => {
  let server: http.Server;
  let port: number;
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(async () => {
    server = app.listen(0);
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as any).fetch;
    }
  });

  function connect(port: number, headers: Record<string, string> = {}): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function nextMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      ws.once('message', (data) => {
        try {
          resolve(JSON.parse(data.toString()));
        } catch (error) {
          reject(error);
        }
      });
      ws.once('error', reject);
    });
  }

  function setupWs(): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
    const wsServer = http.createServer();
    const hub = new StreamHub(wsServer);
    return new Promise((resolve) => {
      wsServer.listen(0, '127.0.0.1', () => {
        resolve({ server: wsServer, hub, port: (wsServer.address() as { port: number }).port });
      });
    });
  }

  async function teardownWs(server: http.Server, hub: StreamHub): Promise<void> {
    await new Promise((resolve) => hub.close(() => resolve(undefined)));
    server.close();
    await once(server, 'close');
  }

  it('preserves separate correlation IDs for concurrent request contexts', async () => {
    const reqA = { headers: { [CORRELATION_ID_HEADER]: '123e4567-e89b-12d3-a456-426614174000' } } as any;
    const resA = { setHeader: vi.fn() } as any;
    const reqB = { headers: {} } as any;
    const resB = { setHeader: vi.fn() } as any;

    const promiseA = new Promise<string>((resolve) => {
      correlationIdMiddleware(reqA, resA, () => {
        setImmediate(() => resolve(getCorrelationId()));
      });
    });

    const promiseB = new Promise<string>((resolve) => {
      correlationIdMiddleware(reqB, resB, () => {
        setImmediate(() => resolve(getCorrelationId()));
      });
    });

    const [correlationA, correlationB] = await Promise.all([promiseA, promiseB]);

    expect(correlationA).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(isValidCorrelationId(correlationB)).toBe(true);
    expect(correlationA).not.toBe(correlationB);
    expect(resA.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, correlationA);
    expect(resB.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, correlationB);
  });

  it('attaches the initiating correlation ID to websocket broadcast events', async () => {
    const { server: wsServer, hub, port: wsPort } = await setupWs();

    try {
      const clientCorrelationId = '123e4567-e89b-12d3-a456-426614174001';
      const ws = await connect(wsPort, { [CORRELATION_ID_HEADER]: clientCorrelationId });

      // Collect any inbound messages on a persistent listener registered
      // immediately after the connection opens. This avoids the race where
      // once() is registered after the 'message' event has already fired.
      const received: Record<string, unknown>[] = [];
      ws.on('message', (data) => {
        try {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        } catch {
          /* ignore non-JSON */
        }
      });

      ws.send(JSON.stringify({ type: 'subscribe', streamId: 'stream-1' }));

      // Wait for the server to register the subscription before broadcasting.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      await correlationStore.run('internal-corr-id-1', async () => {
        await hub.broadcast({ streamId: 'stream-1', eventId: 'evt-1', payload: { message: 'hello' } });
      });

      // Allow the broadcast frame to traverse the loopback socket and the
      // client's 'message' handler to run.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const payload = received.find((m) => m.type === 'stream_update');
      expect(payload).toBeDefined();
      expect(payload?.correlationId).toBe('internal-corr-id-1');

      const clientState = Array.from((hub as any).clients.values())[0] as any;
      expect(clientState.correlationId).toBe(clientCorrelationId);
      ws.close();
    } finally {
      await teardownWs(wsServer, hub);
    }
  });

  it('includes X-Correlation-ID when dispatching outgoing webhooks', async () => {
    let captured: RequestInit | undefined;
    global.fetch = (async (_url: string, options?: RequestInit) => {
      captured = options;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await correlationStore.run('webhook-corr-123', async () => {
      const result = await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret',
        payload: JSON.stringify({ foo: 'bar' }),
        deliveryId: 'deliv-123',
        eventType: 'stream.created',
      });

      expect(result.success).toBe(true);
    });

    const headers = captured?.headers as Record<string, string>;
    expect(headers[CORRELATION_ID_HEADER]).toBe('webhook-corr-123');
  });

  it('propagates a regenerated ID to downstream webhooks after rejecting a bad inbound ID', async () => {
    let captured: RequestInit | undefined;
    const maliciousId = '11111111-1111-4111-8111-111111111111\nlog=forged';
    const req = { headers: { [CORRELATION_ID_HEADER]: maliciousId } } as any;
    const res = { setHeader: vi.fn() } as any;

    global.fetch = (async (_url: string, options?: RequestInit) => {
      captured = options;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await new Promise<void>((resolve, reject) => {
      correlationIdMiddleware(req, res, () => {
        void webhookDispatcher.dispatch({
          url: 'https://example.com/webhook',
          secret: 'secret',
          payload: JSON.stringify({ foo: 'bar' }),
          deliveryId: 'deliv-bad-correlation-id',
          eventType: 'stream.created',
        }).then((result) => {
          expect(result.success).toBe(true);
          resolve();
        }, reject);
      });
    });

    const regeneratedId = req.correlationId as string;
    const headers = captured?.headers as Record<string, string>;
    expect(regeneratedId).not.toBe(maliciousId);
    expect(regeneratedId).not.toContain('\n');
    expect(isValidCorrelationId(regeneratedId)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, regeneratedId);
    expect(headers[CORRELATION_ID_HEADER]).toBe(regeneratedId);
  });
});
