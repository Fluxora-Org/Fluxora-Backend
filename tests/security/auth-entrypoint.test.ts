/**
 * Authoritative authentication path (#1579).
 *
 * src/middleware/auth.ts is the authoritative HTTP auth entry point. These
 * tests enforce that:
 *  - no route file verifies tokens itself (lib/auth verifyToken, jsonwebtoken)
 *  - every route file that uses requireAuth / requirePermission also runs
 *    `authenticate` (requirePermission alone rejects everyone — the bug that
 *    made POST /api/auth/revoke unusable)
 *  - the removed duplicate helper (createBearerTokenAuth) stays removed
 *  - POST /api/auth/revoke now reaches the authoritative path end to end
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import express from 'express';
import request from 'supertest';
import { authRouter } from '../../src/routes/auth.js';
import { generateToken } from '../../src/lib/auth.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import * as tokenAuth from '../../src/middleware/tokenAuth.js';

const ROOT = process.cwd();

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listTs(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Files that register HTTP routes. */
const ROUTE_FILES = [
  ...listTs(join(ROOT, 'src', 'routes')),
  join(ROOT, 'src', 'graphql', 'gateway.ts'),
].map((file) => ({ file: relative(ROOT, file).replace(/\\/g, '/'), src: readFileSync(file, 'utf8') }));

describe('authoritative auth path — static checks on route files', () => {
  it('finds the route files to check', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(10);
  });

  it.each(ROUTE_FILES.map((f) => [f.file, f.src]))(
    '%s does not verify tokens itself',
    (_file, src) => {
      expect(src).not.toMatch(/from ['"]jsonwebtoken['"]/);
      expect(src).not.toMatch(/import\s*\{[^}]*\bverifyToken\b[^}]*\}\s*from ['"][./]+lib\/auth\.js['"]/);
    },
  );

  it.each(
    ROUTE_FILES.filter((f) => /\brequire(Auth|Permission)\s*\(|\brequireAuth\b/.test(f.src)).map((f) => [f.file, f.src]),
  )('%s runs `authenticate` before requireAuth / requirePermission', (_file, src) => {
    expect(src).toMatch(/import\s*\{[^}]*\bauthenticate\b[^}]*\}\s*from ['"][./]+middleware\/auth\.js['"]/);
  });

  it('covers the auth router (regression for POST /api/auth/revoke)', () => {
    const auth = ROUTE_FILES.find((f) => f.file === 'src/routes/auth.ts');
    expect(auth).toBeDefined();
    expect(auth!.src).toMatch(/'\/revoke',\s*(\/\/[^\n]*\n\s*)*authenticate,\s*requirePermission\(/);
  });
});

describe('duplicate auth helpers are removed', () => {
  it('tokenAuth no longer exports createBearerTokenAuth', () => {
    expect((tokenAuth as Record<string, unknown>).createBearerTokenAuth).toBeUndefined();
    expect(typeof tokenAuth.verifyWsToken).toBe('function');
  });

  it('only the auth modules call verifyToken', () => {
    const callers = listTs(join(ROOT, 'src'))
      .filter((file) => /\bverifyToken\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual(['src/lib/auth.ts', 'src/middleware/adminAuth.ts', 'src/middleware/auth.ts']);
  });

  it('docs name src/middleware/auth.ts as the authoritative entry point', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'auth.md'), 'utf8');
    expect(doc).toContain('**`src/middleware/auth.ts` is the authoritative authentication entry point.**');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('the authoritative auth entry point');
  });
});

describe('POST /api/auth/revoke reaches the authoritative path', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use(errorHandler);
    return app;
  }

  it('rejects an anonymous caller with 401', async () => {
    const res = await request(makeApp()).post('/api/auth/revoke').send({});
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated caller without admin:pause with 403', async () => {
    const token = generateToken({ address: 'GVIEWER', role: 'viewer', permissions: ['streams:read'] });
    const res = await request(makeApp())
      .post('/api/auth/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('lets an admin through to the handler (400 on an empty body, not 401)', async () => {
    const token = generateToken({ address: 'GADMIN', role: 'admin', permissions: ['admin:pause'] });
    const res = await request(makeApp())
      .post('/api/auth/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
