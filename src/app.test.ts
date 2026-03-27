import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const application = createApp({ includeTestRoutes: true });
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
    const data = await res.json() as { error: Record<string, unknown> };
    expect(res.status).toBe(404);
    expect(data.error['code']).toBe('not_found');
    expect(data.error['status']).toBe(404);
    expect(data.error['requestId']).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns a normalized 400 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sender":',
    });
    const data = await res.json() as { error: Record<string, unknown> };
    expect(res.status).toBe(400);
    expect(data.error['code']).toBe('invalid_json');
    expect(data.error['status']).toBe(400);
  });

  it('returns a normalized 413 for oversized payloads', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'a', recipient: 'b', depositAmount: '10', ratePerSecond: '1', blob: 'x'.repeat(300_000) }),
    });
    const data = await res.json() as { error: Record<string, unknown> };
    expect(res.status).toBe(413);
    expect(data.error['code']).toBe('payload_too_large');
    expect(data.error['status']).toBe(413);
  });

  it('returns a normalized 400 for missing required fields', async () => {
    const res = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'alice' }),
    });
    const data = await res.json() as { error: Record<string, unknown> };
    expect(res.status).toBe(400);
    // The streams route uses middleware/errorHandler which returns VALIDATION_ERROR
    expect(typeof data.error['code']).toBe('string');
    expect(data.error['status']).toBe(400);
  });

  it('returns a normalized 500 for unexpected failures', async () => {
    const res = await fetch(`${baseUrl}/__test/error`);
    const data = await res.json() as { error: Record<string, unknown> };
    expect(res.status).toBe(500);
    expect(data.error['code']).toBe('internal_error');
    expect(data.error['status']).toBe(500);
    expect(data.error['message']).toBe('Internal server error');
  });
});
