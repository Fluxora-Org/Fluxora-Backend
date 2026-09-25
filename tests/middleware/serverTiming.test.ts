import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  serverTimingMiddleware,
  getServerTimingRegistry,
  createServerTimingRegistry,
  isAuthorizedTimingCaller,
  isTimingOptIn,
  maskPhaseName,
  COMPONENT_NAME_MAP,
  SAFE_GENERIC_NAMES,
} from '../../src/middleware/serverTiming.js';

describe('Server Timing middleware', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  // ── Baseline and development behavior ───────────────────────────────────────

  it('adds a Server-Timing header with sanitized phase timings when enabled', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/timed', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 12.5);
      registry.addPhase('serialize', 3.75);
      res.json({ ok: true });
    });

    const res = await request(app).get('/timed');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toBe('db;dur=12.5, serialize;dur=3.75');
  });

  it('does not emit the header when disabled by env', async () => {
    process.env.SERVER_TIMING_ENABLED = 'false';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/timed', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 12.5);
      res.json({ ok: true });
    });

    const res = await request(app).get('/timed');
    expect(res.headers['server-timing']).toBeUndefined();
  });

  it('sanitizes phase names and drops unsafe values', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/timed', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db\nInjected', 12.5);
      registry.addPhase('stellar_rpc', Number.NaN);
      registry.addPhase('serialize', 3.75);
      res.json({ ok: true });
    });

    const res = await request(app).get('/timed');
    expect(res.headers['server-timing']).toBe('serialize;dur=3.75');
  });

  it('keeps the header unset when no phases are recorded', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/empty', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/empty');
    expect(res.headers['server-timing']).toBeUndefined();
  });

  it('returns a stable snapshot for the current request', () => {
    const registry = createServerTimingRegistry();
    registry.addPhase('db', 12.5);
    registry.addPhase('serialize', 3.75);

    expect(registry.snapshot()).toEqual([
      { name: 'db', durationMs: 12.5 },
      { name: 'serialize', durationMs: 3.75 },
    ]);
  });

  it('handles res.end(chunk) without explicit encoding argument', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/end-no-encoding', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 10.0);
      res.end('response text');
    });

    const res = await request(app).get('/end-no-encoding');
    expect(res.status).toBe(200);
    expect(res.text).toBe('response text');
    expect(res.headers['server-timing']).toBe('db;dur=10');
  });

  it('handles res.end(chunk, encoding) with explicit encoding argument', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/end-with-encoding', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 15.0);
      res.end('response text', 'utf8');
    });

    const res = await request(app).get('/end-with-encoding');
    expect(res.status).toBe(200);
    expect(res.text).toBe('response text');
    expect(res.headers['server-timing']).toBe('db;dur=15');
  });

  it('intercepts res.write and res.send properly', async () => {
    process.env.SERVER_TIMING_ENABLED = 'true';
    const app = express();
    app.use(serverTimingMiddleware());
    app.get('/write-send', (_req, res) => {
      const registry = getServerTimingRegistry(res);
      registry.addPhase('db', 8.2);
      res.write('part 1');
      res.end('part 2');
    });

    const res = await request(app).get('/write-send');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toBe('db;dur=8.2');
  });

  // ── Acceptance Criteria: Production gating by default ───────────────────────

  describe('Production configuration security gating', () => {
    it('omits detailed timings in production configuration by default', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 12.5);
        registry.addPhase('serialize', 3.75);
        res.json({ ok: true });
      });

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeUndefined();
    });

    it('rejects unauthenticated callers even when opt-in header is provided in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 12.5);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('X-Server-Timing', '1');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeUndefined();
    });

    it('rejects unauthorized roles (viewer) even when opt-in header is provided', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      // Simulate auth middleware setting unprivileged user
      app.use((req, _res, next) => {
        (req as unknown as { user: { role: string } }).user = { role: 'viewer' };
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 12.5);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('X-Server-Timing', '1');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeUndefined();
    });

    it('omits timings for authorized caller (admin) when opt-in is not specified', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { user: { role: string } }).user = { role: 'admin' };
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 12.5);
        res.json({ ok: true });
      });

      // Admin request without opt-in header
      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeUndefined();
    });

    it('exposes timings when authorized caller (admin role) explicitly opts in', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { user: { role: string } }).user = { role: 'admin' };
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 12.5);
        registry.addPhase('serialize', 3.75);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('X-Server-Timing', 'true');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeDefined();
    });

    it('exposes timings when authorized caller (operator role) explicitly opts in with Prefer header', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { user: { role: string } }).user = { role: 'operator' };
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 15.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Prefer', 'server-timing');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeDefined();
    });

    it('exposes timings when authorized by API key scope (timing scope) and opt-in', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { keyScopes: string[] }).keyScopes = ['timing:read'];
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 10.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Server-Timing', '1');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeDefined();
    });

    it('exposes timings when authorized via ADMIN_API_KEY Bearer token and opt-in', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';
      process.env.ADMIN_API_KEY = 'correct-admin-key-secret';

      const app = express();
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 22.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test?timing=1')
        .set('Authorization', 'Bearer correct-admin-key-secret');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeDefined();
    });

    it('rejects invalid ADMIN_API_KEY Bearer token even with opt-in', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';
      process.env.ADMIN_API_KEY = 'correct-admin-key-secret';

      const app = express();
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 22.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer wrong-admin-key-token')
        .set('X-Server-Timing', '1');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeUndefined();
    });

    it('exposes timings when authorized via SERVER_TIMING_SECRET and opt-in', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';
      process.env.SERVER_TIMING_SECRET = 'timing-special-secret-123';

      const app = express();
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 18.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('X-Server-Timing-Key', 'timing-special-secret-123')
        .set('X-Server-Timing', '1');

      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBeDefined();
    });
  });

  // ── Acceptance Criteria: Timing names do not reveal internal components ──────

  describe('Component name masking', () => {
    it('masks internal component names (db, serialize, stellar_rpc) in production exposure', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { user: { role: string } }).user = { role: 'admin' };
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 12.5);
        registry.addPhase('serialize', 3.75);
        registry.addPhase('stellar_rpc', 25.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('X-Server-Timing', '1');

      expect(res.status).toBe(200);
      const header = res.headers['server-timing'];
      expect(header).toBeDefined();

      // Assert architecture-neutral names are emitted
      expect(header).toContain('data;dur=12.5');
      expect(header).toContain('render;dur=3.75');
      expect(header).toContain('upstream;dur=25');

      // Assert internal component names are NOT revealed
      expect(header).not.toContain('db;');
      expect(header).not.toContain('serialize;');
      expect(header).not.toContain('stellar_rpc;');
    });

    it('masks unknown internal phase names to generic process label in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SERVER_TIMING_ENABLED = 'true';

      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { user: { role: string } }).user = { role: 'admin' };
        next();
      });
      app.use(serverTimingMiddleware());
      app.get('/api/test', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('internal_ledger_processor', 42.0);
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/api/test')
        .set('X-Server-Timing', '1');

      expect(res.status).toBe(200);
      const header = res.headers['server-timing'];
      expect(header).toBe('process;dur=42');
      expect(header).not.toContain('internal_ledger_processor');
    });

    it('preserves approved generic names without masking', () => {
      expect(maskPhaseName('total')).toBe('total');
      expect(maskPhaseName('process')).toBe('process');
      expect(maskPhaseName('data')).toBe('data');
      expect(maskPhaseName('render')).toBe('render');
      expect(maskPhaseName('upstream')).toBe('upstream');
      expect(maskPhaseName('lookup')).toBe('lookup');
      expect(maskPhaseName('job')).toBe('job');
      expect(maskPhaseName('security')).toBe('security');
    });

    it('maps all defined component names correctly', () => {
      expect(COMPONENT_NAME_MAP['db']).toBe('data');
      expect(COMPONENT_NAME_MAP['serialize']).toBe('render');
      expect(COMPONENT_NAME_MAP['stellar_rpc']).toBe('upstream');
      expect(COMPONENT_NAME_MAP['postgres']).toBe('data');
      expect(COMPONENT_NAME_MAP['redis']).toBe('lookup');
      expect(COMPONENT_NAME_MAP['auth']).toBe('security');
      expect(SAFE_GENERIC_NAMES.has('data')).toBe(true);
    });

    it('allows custom name mapping via middleware options', async () => {
      const app = express();
      app.use(
        serverTimingMiddleware({
          enabled: true,
          isProduction: true,
          isAuthorized: () => true,
          isOptIn: () => true,
          nameMap: {
            db: 'custom_storage_tier',
          },
        }),
      );
      app.get('/api/custom-map', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 5.5);
        res.json({ ok: true });
      });

      const res = await request(app).get('/api/custom-map');
      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBe('custom_storage_tier;dur=5.5');
    });

    it('supports maskComponentNames option even in non-production environments', async () => {
      process.env.NODE_ENV = 'development';
      const app = express();
      app.use(
        serverTimingMiddleware({
          enabled: true,
          maskComponentNames: true,
        }),
      );
      app.get('/api/dev-masked', (_req, res) => {
        const registry = getServerTimingRegistry(res);
        registry.addPhase('db', 7.0);
        res.json({ ok: true });
      });

      const res = await request(app).get('/api/dev-masked');
      expect(res.status).toBe(200);
      expect(res.headers['server-timing']).toBe('data;dur=7');
    });
  });

  // ── Helper unit tests ───────────────────────────────────────────────────────

  describe('Authorization and Opt-in helpers', () => {
    it('isAuthorizedTimingCaller returns false for empty request', () => {
      const mockReq = { headers: {} } as unknown as express.Request;
      expect(isAuthorizedTimingCaller(mockReq)).toBe(false);
    });

    it('isTimingOptIn correctly recognizes various opt-in signals', () => {
      const reqWithXHeader = { headers: { 'x-server-timing': '1' } } as unknown as express.Request;
      expect(isTimingOptIn(reqWithXHeader)).toBe(true);

      const reqWithHeaderTrue = { headers: { 'server-timing': 'true' } } as unknown as express.Request;
      expect(isTimingOptIn(reqWithHeaderTrue)).toBe(true);

      const reqWithPrefer = { headers: { prefer: 'return=representation, server-timing' } } as unknown as express.Request;
      expect(isTimingOptIn(reqWithPrefer)).toBe(true);

      const reqWithQuery = { headers: {}, query: { timing: '1' } } as unknown as express.Request;
      expect(isTimingOptIn(reqWithQuery)).toBe(true);

      const reqWithoutOptIn = { headers: {}, query: {} } as unknown as express.Request;
      expect(isTimingOptIn(reqWithoutOptIn)).toBe(false);
    });
  });
});
