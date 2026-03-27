import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createApp } from './app.js';

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp({ includeTestRoutes: true });
  const server = app.listen(0);
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('returns a normalized 404 envelope for unknown routes', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    const data = await response.json();

    assert.equal(response.status, 404);
    assert.equal(data.error.code, 'not_found');
    assert.equal(data.error.status, 404);
    assert.ok(data.error.requestId);
    assert.ok(response.headers.get('x-request-id'));
  });
});

test('returns a normalized 400 envelope for invalid JSON', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"sender":',
    });
    const data = await response.json();

    assert.equal(response.status, 400);
    assert.equal(data.error.code, 'invalid_json');
    assert.equal(data.error.status, 400);
  });
});

test('returns a normalized 413 envelope for oversized payloads', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: 'alice',
        recipient: 'bob',
        depositAmount: '10',
        ratePerSecond: '1',
        startTime: 1710000000,
        blob: 'a'.repeat(300_000),
      }),
    });
    const data = await response.json();

    assert.equal(response.status, 413);
    assert.equal(data.error.code, 'payload_too_large');
    assert.equal(data.error.status, 413);
  });
});

test('returns validation errors in the normalized envelope', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/streams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: 'alice',
      }),
    });
    const data = await response.json();

    assert.equal(response.status, 400);
    assert.equal(data.error.code, 'validation_error');
    assert.equal(data.error.status, 400);
    assert.deepEqual(data.error.details, {
      field: 'recipient',
    });
  });
});

test('returns a normalized 500 envelope for unexpected failures', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/__test/error`);
    const data = await response.json();

    assert.equal(response.status, 500);
    assert.equal(data.error.code, 'internal_error');
    assert.equal(data.error.status, 500);
    assert.equal(data.error.message, 'Internal server error');
  });
});
