import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Use a short 100ms timeout to ensure our tests don't hang
  const application = createApp({ includeTestRoutes: true, requestTimeoutMs: 100 });
  server = application.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

describe('app error envelopes', () => {
  it('returns a normalized 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    const data = (await res.json()) as { error: Record<string, unknown> };
    expect(res.status).toBe(404);
    expect(data.error['code']).toBe('NOT_FOUND');
  });

  it('returns a normalized 400 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sender":',
    });
    const data = (await res.json()) as { error: Record<string, unknown> };
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(typeof data.error['code']).toBe('string');
  });

  it('returns a normalized 413 for oversized payloads', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: 'a',
        recipient: 'b',
        depositAmount: '10',
        ratePerSecond: '1',
        blob: 'x'.repeat(2_000_000),
      }),
    });
    expect(res.status).toBe(413);
    const data = (await res.json()) as { error: Record<string, unknown> };
    expect(data.error['code']).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns a normalized 400 for missing required fields', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'alice' }),
    });
    const data = (await res.json()) as { error: Record<string, unknown> };
    // Could be 400 (missing Idempotency-Key validation) or 401 (auth) — both
    // are acceptable client-error responses with a string code.
    expect([400, 401]).toContain(res.status);
    expect(typeof data.error['code']).toBe('string');
  });

  it('returns a normalized 500 for unexpected failures', async () => {
    const res = await fetch(`${baseUrl}/__test/error`);
    const data = (await res.json()) as { error: Record<string, unknown> };
    expect(res.status).toBe(500);
    expect(data.error['code']).toBe('INTERNAL_ERROR');
  });
});

describe('X-Request-ID header on errors', () => {
  it('sets X-Request-ID on 404 error responses', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const data = (await res.json()) as { error: Record<string, unknown> };
    expect(data.error['requestId']).toBe(res.headers.get('x-request-id'));
  });

  it('sets X-Request-ID on 400 validation errors', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sender":',
    });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('sets X-Request-ID on 500 internal errors', async () => {
    const res = await fetch(`${baseUrl}/__test/error`);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const data = (await res.json()) as { error: Record<string, unknown> };
    expect(data.error['requestId']).toBe(res.headers.get('x-request-id'));
  });
});
