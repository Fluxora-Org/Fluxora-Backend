import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { adminRouter } from '../../src/routes/admin.js';
import { generateToken } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';

function extractRouterPaths(router: any, basePath: string): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  
  if (!router || !router.stack) return routes;

  router.stack.forEach((layer: any) => {
    if (layer.route) {
      const p = layer.route.path;
      for (const method in layer.route.methods) {
        if (layer.route.methods[method]) {
          routes.push({ method: method.toUpperCase(), path: basePath + (p === '/' ? '' : p) });
        }
      }
    } else if (layer.name === 'router' && layer.handle.stack) {
      // It's a sub-router. Let's try to parse the base path from the regexp.
      // e.g. /^\/rate-limits\/overrides\/?(?=\/|$)/i
      let subPath = '';
      const match = layer.regexp.toString().match(/^\/\^\\(.*?)\\\/\?\(\?\=\\\/\|\$\)\/i/);
      if (match && match[1]) {
        subPath = '/' + match[1].replace(/\\\//g, '/');
      } else {
        // Fallback for known routers in admin.ts
        if (layer.regexp.toString().includes('rate-limits')) {
          subPath = '/rate-limits/overrides';
        }
      }
      routes.push(...extractRouterPaths(layer.handle, basePath + subPath));
    }
  });

  return routes;
}

describe('Admin Boundary Enforcement', () => {
  let prevAdminKey: string | undefined;
  let prevJwtSecret: string | undefined;

  beforeAll(() => {
    prevAdminKey = process.env.ADMIN_API_KEY;
    prevJwtSecret = process.env.JWT_SECRET;
    process.env.ADMIN_API_KEY = 'test-admin-key-for-boundary-suite';
    process.env.JWT_SECRET = 'test-jwt-secret';
    initializeConfig();
  });

  afterAll(() => {
    if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdminKey;

    if (prevJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwtSecret;
  });

  it('every admin route refuses user credentials', async () => {
    const adminRoutes = extractRouterPaths(adminRouter, '/api/admin');
    
    // A regular user credential (not admin)
    const userToken = generateToken({ address: 'user-123', role: 'user' });

    for (const route of adminRoutes) {
      let req = (request(app) as any)[route.method.toLowerCase()](route.path)
        .set('Authorization', `Bearer ${userToken}`);
      
      if (['POST', 'PUT', 'PATCH'].includes(route.method)) {
        req = req.send({});
      }

      const res = await req;
      
      // If a route returns 2xx or doesn't return 401/403, it means a user token bypassed the admin check
      expect(
        [401, 403].includes(res.status), 
        `Route ${route.method} ${route.path} failed to refuse user credential (status ${res.status})`
      ).toBe(true);
    }
  });
});
