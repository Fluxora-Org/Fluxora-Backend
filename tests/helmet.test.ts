import { describe, it, expect } from 'vitest';
import { Duplex } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/app.js';

async function performRequest(path: string): Promise<Record<string, string | string[] | number>> {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const req = new IncomingMessage(socket);
  req.method = 'GET';
  req.url = path;
  req.headers = {};

  const res = new ServerResponse(req);
  res.assignSocket(socket);

  return await new Promise((resolve, reject) => {
    res.on('finish', () => {
      resolve({
        status: res.statusCode,
        ...res.getHeaders(),
      });
    });
    res.on('error', reject);

    app.handle(req, res, reject);
  });
}

describe('helmet security headers', () => {
  it('sets Content-Security-Policy header', async () => {
    const res = await performRequest('/');
    expect(res['content-security-policy']).toBeDefined();
  });

  it('sets X-Content-Type-Options to nosniff', async () => {
    const res = await performRequest('/');
    expect(res['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options to SAMEORIGIN', async () => {
    const res = await performRequest('/');
    expect(res['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('removes X-Powered-By header', async () => {
    const res = await performRequest('/');
    expect(res['x-powered-by']).toBeUndefined();
  });

  it('sets Strict-Transport-Security header', async () => {
    const res = await performRequest('/');
    expect(res['strict-transport-security']).toBeDefined();
  });

  it('sets X-DNS-Prefetch-Control header', async () => {
    const res = await performRequest('/');
    expect(res['x-dns-prefetch-control']).toBe('off');
  });

  it('sets X-Download-Options header', async () => {
    const res = await performRequest('/');
    expect(res['x-download-options']).toBe('noopen');
  });

  it('sets X-Permitted-Cross-Domain-Policies header', async () => {
    const res = await performRequest('/');
    expect(res['x-permitted-cross-domain-policies']).toBe('none');
  });

  it('sets Referrer-Policy header', async () => {
    const res = await performRequest('/');
    expect(res['referrer-policy']).toBeDefined();
  });

  it('applies headers to all routes', async () => {
    const routes = ['/health', '/api/streams', '/'];
    for (const route of routes) {
      const res = await performRequest(route);
      expect(res['x-content-type-options']).toBe('nosniff');
      expect(res['x-frame-options']).toBe('SAMEORIGIN');
      expect(res['x-powered-by']).toBeUndefined();
    }
  });
});
