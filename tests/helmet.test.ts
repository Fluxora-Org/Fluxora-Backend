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

  // --- Strict CSP assertions ---

  it('CSP default-src is self only', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    expect(csp).toMatch(/default-src 'self'/);
  });

  it('CSP script-src does not contain unsafe-inline or unsafe-eval', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    // Extract the script-src directive
    const match = csp.match(/script-src ([^;]+)/);
    expect(match).not.toBeNull();
    const scriptSrc = match![1];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('CSP style-src does not contain unsafe-inline', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    const match = csp.match(/style-src ([^;]+)/);
    expect(match).not.toBeNull();
    const styleSrc = match![1];
    expect(styleSrc).not.toContain("'unsafe-inline'");
  });

  it('CSP script-src and style-src include a per-request nonce', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    // nonce-<base64> pattern
    expect(csp).toMatch(/nonce-[A-Za-z0-9+/]+=*/);
  });

  it('CSP nonce is unique per request', async () => {
    const res1 = await performRequest('/');
    const res2 = await performRequest('/');
    const csp1 = res1['content-security-policy'] as string;
    const csp2 = res2['content-security-policy'] as string;
    const nonce1 = csp1.match(/nonce-([A-Za-z0-9+/=]+)/)?.[1];
    const nonce2 = csp2.match(/nonce-([A-Za-z0-9+/=]+)/)?.[1];
    expect(nonce1).toBeDefined();
    expect(nonce2).toBeDefined();
    expect(nonce1).not.toBe(nonce2);
  });

  it('CSP object-src is none', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    expect(csp).toMatch(/object-src 'none'/);
  });

  it('CSP frame-src is none', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    expect(csp).toMatch(/frame-src 'none'/);
  });

  it('CSP includes upgrade-insecure-requests', async () => {
    const res = await performRequest('/');
    const csp = res['content-security-policy'] as string;
    expect(csp).toContain('upgrade-insecure-requests');
  });
});
