import http from 'http';
import { once } from 'node:events';
import request from 'supertest';
import { WebSocket } from 'ws';
import { app } from '../src/app';
import { correlationIdMiddleware, CORRELATION_ID_HEADER, isValidCorrelationId } from '../src/middleware/correlationId';
import { correlationStore, getCorrelationId } from '../src/tracing/middleware';
import { StreamHub } from '../src/ws/hub';
import { webhookDispatcher } from '../src/webhooks/dispatcher';

describe('correlationId middleware', () => {
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
      const clientId = 'my-client-id-123';
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(clientId);
    });

    it('trims whitespace from incoming header', async () => {
      const clientId = '  trimmed-id  ';
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe('trimmed-id');
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
    await new Promise((resolve) => hub.close(resolve));
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
      ws.send(JSON.stringify({ type: 'subscribe', streamId: 'stream-1' }));

      await correlationStore.run('internal-corr-id-1', async () => {
        await hub.broadcast({ streamId: 'stream-1', eventId: 'evt-1', payload: { message: 'hello' } });
      });

      const payload = (await nextMessage(ws)) as any;
      expect(payload.type).toBe('stream_update');
      expect(payload.correlationId).toBe('internal-corr-id-1');

      const clientState = Array.from((hub as any).clients.values())[0] as any;
      expect(clientState.correlationId).toBe(clientCorrelationId);
      ws.close();
    } finally {
      await teardownWs(wsServer, hub);
    }
  });

  it('includes X-Correlation-ID when dispatching outgoing webhooks', async () => {
    let captured: RequestInit | undefined;
    global.fetch = async (_url: string, options?: RequestInit) => {
      captured = options;
      return new Response(null, { status: 200 });
    } as any;

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
});
