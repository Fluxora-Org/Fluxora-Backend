import { describe, it, expect } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { methodOverrideMiddleware } from '../../src/middleware/methodOverride.js';

/**
 * Integration test: proves that the methodOverrideMiddleware gate on credential
 * header presence + downstream auth middleware ensures a POST with
 * invalid credentials and a method override header cannot reach a DELETE
 * handler without passing real authentication.
 */
describe('methodOverrideMiddleware integration', () => {
  function createTestApp(authMiddleware?: (req: Request, res: Response, next: NextFunction) => void): Express {
    const app = express();
    app.use(express.json());
    // Method override runs first (as in production)
    app.use(methodOverrideMiddleware);

    // Optional auth middleware
    if (authMiddleware) {
      app.use(authMiddleware);
    }

    // A DELETE handler that should only be reached by authenticated requests
    app.delete('/api/streams/test', (_req: Request, res: Response) => {
      res.status(200).json({ message: 'resource deleted' });
    });

    // A POST handler for the same route (normal POST behavior)
    app.post('/api/streams/test', (_req: Request, res: Response) => {
      res.status(201).json({ message: 'resource created' });
    });

    return app;
  }

  it('POST without auth header does not override and reaches POST handler', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/streams/test')
      .set('x-http-method-override', 'DELETE')
      .send({});

    // Without any auth header, the gate prevents override
    // → method stays POST → reaches POST handler
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('resource created');
  });

  it('POST with garbage auth header overrides method but real auth middleware rejects', async () => {
    const app = createTestApp((_req, res, _next) => {
      // Simulate a real auth middleware that rejects invalid credentials
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
    });
    const res = await request(app)
      .post('/api/streams/test')
      .set('x-http-method-override', 'DELETE')
      .set('Authorization', 'Bearer garbage-token')
      .send({});

    // The method was overridden to DELETE, but the auth middleware rejects
    // before the DELETE handler is reached
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('POST with valid auth header overrides method and reaches DELETE handler', async () => {
    const app = createTestApp((req, _res, next) => {
      // Simulate a real auth middleware that accepts valid credentials
      (req as any).user = { id: 'test-user' };
      next();
    });
    const res = await request(app)
      .post('/api/streams/test')
      .set('x-http-method-override', 'DELETE')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    // Method overridden → DELETE → reaches the DELETE handler
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('resource deleted');
  });

  it('POST with garbage X-API-Key overrides method but real auth middleware rejects', async () => {
    const app = createTestApp((_req, res, _next) => {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    });
    const res = await request(app)
      .post('/api/streams/test')
      .set('x-http-method-override', 'DELETE')
      .set('x-api-key', 'garbage-key')
      .send({});

    expect(res.status).toBe(401);
  });

  it('DELETE request directly (no override needed) still requires real auth', async () => {
    const app = createTestApp((_req, res, _next) => {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
    });
    const res = await request(app)
      .delete('/api/streams/test')
      .set('Authorization', 'Bearer garbage-token')
      .send({});

    // methodOverride does not touch this (it's already DELETE)
    // but the auth middleware still rejects
    expect(res.status).toBe(401);
  });
});
