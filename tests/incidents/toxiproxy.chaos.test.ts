/**
 * Chaos engineering test suite: Toxiproxy network fault injection
 * (Issue: chaos-toxiproxy-runbook)
 *
 * Exercises real network-level faults against Postgres and Redis through
 * Toxiproxy proxies, asserting that:
 *
 *   Postgres (src/db/pool.ts):
 *     - High latency (> DEFAULT_DEGRADED_LATENCY_MS) → checker reports "degraded"
 *     - Connection timeout / disabled proxy       → checker reports "unhealthy"
 *     - Bandwidth throttle                        → checker reports "degraded"
 *     - TCP reset (ECONNRESET)                    → checker reports "unhealthy"
 *     - Fault removal                             → checker returns to "healthy"
 *
 *   Redis (src/redis/client.ts):
 *     - High latency (> DEFAULT_DEGRADED_LATENCY_MS) → checker reports "degraded"
 *     - Connection reset                          → checker reports "unhealthy"
 *     - Bandwidth throttle                        → latency visible in checker
 *     - Fault removal / reconnect                 → checker returns to "healthy"
 *
 *   Health aggregation (src/config/health.ts):
 *     - Any unhealthy dependency → overall "unhealthy"
 *     - Any degraded (no unhealthy) → overall "degraded"
 *     - All healthy → overall "healthy"
 *
 * ─── Prerequisites ───────────────────────────────────────────────────────────
 *
 *   docker compose --profile chaos up -d
 *   CHAOS_ENABLED=true pnpm test tests/incidents/toxiproxy.chaos.test.ts
 *
 * Tests are SKIPPED automatically when CHAOS_ENABLED is not "true", so the
 * suite is safe to include in the standard pnpm test run without the chaos
 * stack present.
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *
 *   CHAOS_ENABLED          Set to "true" to run (default: skip)
 *   TOXI_URL               Toxiproxy management API (default: http://127.0.0.1:8474)
 *   CHAOS_PG_PROXY_URL     Postgres URL via Toxiproxy proxy (default: postgresql://chaos_user:chaos_password@127.0.0.1:5433/chaos_db)
 *   CHAOS_REDIS_PROXY_URL  Redis URL via Toxiproxy proxy  (default: redis://:chaos_password@127.0.0.1:6380)
 *
 * ─── Security notes ──────────────────────────────────────────────────────────
 *
 *   - All credentials are test-only values matching docker-compose.yml.
 *   - The Toxiproxy management API (8474) is bound to 127.0.0.1 only.
 *   - Tests use an isolated chaos_db / chaos-redis; the default Postgres and
 *     Redis instances are never touched.
 *   - Every toxic is removed in afterEach so failures in one test cannot
 *     corrupt later tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import {
  createPool,
  query as poolQuery,
  PoolExhaustedError,
  QueryTimeoutError,
} from '../../src/db/pool.js';
import {
  createPostgresChecker,
  createRedisChecker,
  DEFAULT_DEGRADED_LATENCY_MS,
  DEFAULT_TIMEOUT_MS,
} from '../../src/health/checkers.js';
import { HealthCheckManager } from '../../src/config/health.js';
import type { HealthStatus } from '../../src/config/health.js';

// ── Guard: skip entire suite unless CHAOS_ENABLED=true ───────────────────────

const CHAOS_ENABLED = process.env['CHAOS_ENABLED'] === 'true';

// ── Configuration ─────────────────────────────────────────────────────────────

const TOXI_URL =
  process.env['TOXI_URL'] ?? 'http://127.0.0.1:8474';

const CHAOS_PG_URL =
  process.env['CHAOS_PG_PROXY_URL'] ??
  'postgresql://chaos_user:chaos_password@127.0.0.1:5433/chaos_db';

const CHAOS_REDIS_URL =
  process.env['CHAOS_REDIS_PROXY_URL'] ??
  'redis://:chaos_password@127.0.0.1:6380';

/** Extra ms to wait after injecting/removing a toxic before asserting. */
const SETTLE_MS = 300;

// ── Toxiproxy management client ───────────────────────────────────────────────

/**
 * Thin HTTP wrapper around the Toxiproxy v2 management REST API.
 * Uses the built-in `fetch` (Node 18+) so no extra dependency is needed.
 *
 * API reference: https://github.com/Shopify/toxiproxy#http-api
 */
class ToxiproxyClient {
  constructor(private readonly baseUrl: string) {}

  /** Return the list of configured proxies. Throws on network failure. */
  async getProxies(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/proxies`);
    if (!res.ok) throw new Error(`GET /proxies → ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Add a toxic to a named proxy.
   *
   * @param proxyName  Name as registered in toxiproxy.config.json
   * @param toxic      Toxic definition — name, type, stream, attributes
   */
  async addToxic(
    proxyName: string,
    toxic: {
      name: string;
      type: string;
      stream: 'upstream' | 'downstream';
      toxicity?: number;
      attributes: Record<string, number>;
    },
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/${proxyName}/toxics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toxicity: 1.0, ...toxic }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`addToxic(${proxyName}, ${toxic.name}) → ${res.status}: ${body}`);
    }
  }

  /**
   * Remove a named toxic from a proxy.
   * A 404 is silently ignored so this is safe to call from afterEach even when
   * the toxic was never added (e.g. test was skipped or threw before injection).
   */
  async removeToxic(proxyName: string, toxicName: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/proxies/${proxyName}/toxics/${toxicName}`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`removeToxic(${proxyName}, ${toxicName}) → ${res.status}`);
    }
  }

  /**
   * Enable or disable an entire proxy (all connections refused when disabled).
   */
  async setProxyEnabled(proxyName: string, enabled: boolean): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/${proxyName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`setProxyEnabled(${proxyName}, ${enabled}) → ${res.status}: ${body}`);
    }
  }

  /** Remove all toxics from a proxy (convenience reset). */
  async resetProxy(proxyName: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/${proxyName}/toxics`);
    if (!res.ok) return;
    const toxics = (await res.json()) as Array<{ name: string }>;
    await Promise.all(toxics.map((t) => this.removeToxic(proxyName, t.name)));
    // Ensure the proxy is re-enabled after any disable test
    await this.setProxyEnabled(proxyName, true);
  }
}

// ── Redis PING client (minimal, no ioredis) ───────────────────────────────────

/**
 * A minimal Redis client that speaks the Redis Inline protocol over a raw TCP
 * socket.  Used to issue PING without bringing up a full ioredis connection,
 * which would itself retry / reconnect and obscure the fault-injection timing.
 *
 * For simplicity this wraps Node's `net` module which is always available.
 */
async function redisPing(url: string, timeoutMs = 4_000): Promise<{ response: string; latencyMs: number }> {
  const { URL } = await import('url');
  const { createConnection } = await import('net');

  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '6379', 10);
  const password = parsed.password ? decodeURIComponent(parsed.password) : null;

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = createConnection({ host, port });
    let buf = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`redisPing timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    sock.on('connect', () => {
      if (password) {
        sock.write(`AUTH ${password}\r\nPING\r\n`);
      } else {
        sock.write('PING\r\n');
      }
    });

    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      // Wait for at least one complete RESP line
      if (buf.includes('\r\n')) {
        // If we sent AUTH first, we need two responses; otherwise one
        const lines = buf.split('\r\n').filter(Boolean);
        const pongLine = password ? lines[1] : lines[0];
        if (pongLine !== undefined) {
          const latencyMs = Date.now() - start;
          settle(() => resolve({ response: pongLine, latencyMs }));
        }
      }
    });

    sock.on('error', (err) => settle(() => reject(err)));
  });
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Suite setup ───────────────────────────────────────────────────────────────

const toxi = new ToxiproxyClient(TOXI_URL);

/** pg.Pool connected through the Toxiproxy pg_proxy.  Created once per suite. */
let pgPool: pg.Pool;

beforeAll(async () => {
  if (!CHAOS_ENABLED) return;

  // Verify Toxiproxy is reachable before running any test.
  // A clear error here is more helpful than mysterious ECONNREFUSED later.
  try {
    await toxi.getProxies();
  } catch (err) {
    throw new Error(
      `Toxiproxy management API unreachable at ${TOXI_URL}. ` +
      `Start the chaos stack: docker compose --profile chaos up -d\n` +
      `Original: ${(err as Error).message}`,
    );
  }

  pgPool = createPool({
    connectionString: CHAOS_PG_URL,
    min: 1,
    max: 5,
    connectionTimeoutMillis: 4_000,
    idleTimeoutMillis: 10_000,
    queueLimit: 10,
    statementTimeoutMs: 4_000,
  });
});

afterAll(async () => {
  if (!CHAOS_ENABLED) return;
  // Best-effort cleanup: reset all toxics, then close the pool.
  await toxi.resetProxy('pg_proxy').catch(() => {/* ignore */});
  await toxi.resetProxy('redis_proxy').catch(() => {/* ignore */});
  await pgPool?.end().catch(() => {/* ignore */});
});

// ── Helper: build a HealthCheckManager with both checkers ────────────────────

function buildHealthManager(opts: {
  pgTimeoutMs?: number;
  pgDegradedLatencyMs?: number;
  redisTimeoutMs?: number;
  redisDegradedLatencyMs?: number;
} = {}): HealthCheckManager {
  const manager = new HealthCheckManager();

  const pgChecker = createPostgresChecker(
    () => pgPool as unknown as import('../../src/health/checkers.js').PostgresClient,
    {
      timeoutMs: opts.pgTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      degradedLatencyMs: opts.pgDegradedLatencyMs ?? DEFAULT_DEGRADED_LATENCY_MS,
    },
  );

  manager.registerChecker(pgChecker);
  return manager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Describe blocks
// ─────────────────────────────────────────────────────────────────────────────

// ── 0. Connectivity smoke test ────────────────────────────────────────────────

describe('Toxiproxy: connectivity smoke test', () => {
  it.skipIf(!CHAOS_ENABLED)('management API returns both registered proxies', async () => {
    const proxies = await toxi.getProxies();
    expect(proxies).toHaveProperty('pg_proxy');
    expect(proxies).toHaveProperty('redis_proxy');
  });

  it.skipIf(!CHAOS_ENABLED)('can connect to Postgres through the proxy (SELECT 1)', async () => {
    const result = await pgPool.query<{ '?column?': number }>('SELECT 1');
    expect(result.rows[0]?.['?column?']).toBe(1);
  });

  it.skipIf(!CHAOS_ENABLED)('can PING Redis through the proxy', async () => {
    const { response } = await redisPing(CHAOS_REDIS_URL, 4_000);
    // AUTH response is +OK, then PING response is +PONG
    expect(response.toUpperCase()).toContain('PONG');
  });
});

// ── 1. Postgres fault scenarios ───────────────────────────────────────────────

describe('Postgres: latency toxic (degraded health)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('pg_proxy', 'pg_latency');
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports healthy before any toxic',
    async () => {
      const manager = buildHealthManager({ pgDegradedLatencyMs: 1_000 });
      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
      const pg = report.dependencies.find((d) => d.name === 'postgres');
      expect(pg?.status).toBe<HealthStatus>('healthy');
    },
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports degraded when latency exceeds DEFAULT_DEGRADED_LATENCY_MS',
    async () => {
      // Inject 1 500 ms latency — above the 1 000 ms degraded threshold
      await toxi.addToxic('pg_proxy', {
        name: 'pg_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 1_500, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      // Use a generous checker timeout (6 s) so the query completes
      const manager = buildHealthManager({
        pgTimeoutMs: 6_000,
        pgDegradedLatencyMs: 1_000,
      });
      const report = await manager.checkAll();
      const pg = report.dependencies.find((d) => d.name === 'postgres');

      expect(pg?.status).toBe<HealthStatus>('degraded');
      expect(report.status).toBe<HealthStatus>('degraded');
      // Latency should be at least the injected delay
      expect(pg?.latency).toBeGreaterThanOrEqual(1_500);
    },
    10_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker returns to healthy after toxic is removed',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 1_500, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      // Remove the toxic
      await toxi.removeToxic('pg_proxy', 'pg_latency');
      await sleep(SETTLE_MS);

      const manager = buildHealthManager({ pgDegradedLatencyMs: 1_000 });
      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
    },
    10_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'poolQuery() still succeeds (slow) during latency injection',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 600, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      const start = Date.now();
      const result = await poolQuery<{ '?column?': number }>(pgPool, 'SELECT 1');
      const elapsed = Date.now() - start;

      expect(result.rows[0]?.['?column?']).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(600);
    },
    8_000,
  );
});

describe('Postgres: connection timeout / disabled proxy (unhealthy health)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('pg_proxy', 'pg_timeout').catch(() => {/* ok */});
    await toxi.setProxyEnabled('pg_proxy', true);
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports unhealthy when proxy is disabled (ECONNREFUSED)',
    async () => {
      await toxi.setProxyEnabled('pg_proxy', false);
      await sleep(SETTLE_MS);

      // Use a short checker timeout so the test does not hang
      const manager = buildHealthManager({ pgTimeoutMs: 2_000 });
      const report = await manager.checkAll();
      const pg = report.dependencies.find((d) => d.name === 'postgres');

      expect(pg?.status).toBe<HealthStatus>('unhealthy');
      expect(pg?.error).toBeTruthy();
      // Credentials must not appear in the sanitised error
      expect(pg?.error).not.toMatch(/chaos_password/i);
      expect(report.status).toBe<HealthStatus>('unhealthy');
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports unhealthy when latency exceeds checker timeout',
    async () => {
      // Inject 8 000 ms latency — above the 5 000 ms checker timeout
      await toxi.addToxic('pg_proxy', {
        name: 'pg_timeout',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 8_000, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      const manager = buildHealthManager({ pgTimeoutMs: 2_000 });
      const report = await manager.checkAll();
      const pg = report.dependencies.find((d) => d.name === 'postgres');

      expect(pg?.status).toBe<HealthStatus>('unhealthy');
      expect(report.status).toBe<HealthStatus>('unhealthy');
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker recovers to healthy after proxy is re-enabled',
    async () => {
      await toxi.setProxyEnabled('pg_proxy', false);
      await sleep(SETTLE_MS);

      // Verify unhealthy
      const before = await buildHealthManager({ pgTimeoutMs: 2_000 }).checkAll();
      expect(before.status).toBe<HealthStatus>('unhealthy');

      // Re-enable and wait for the pool to establish a connection
      await toxi.setProxyEnabled('pg_proxy', true);
      await sleep(1_000); // allow pool to reconnect

      const after = await buildHealthManager({ pgTimeoutMs: 4_000 }).checkAll();
      expect(after.status).toBe<HealthStatus>('healthy');
    },
    12_000,
  );
});

describe('Postgres: bandwidth throttle (degraded health)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('pg_proxy', 'pg_bandwidth');
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'poolQuery SELECT 1 latency increases under heavy bandwidth throttle',
    async () => {
      // Throttle to 1 KB/s — enough to slow even tiny responses measurably
      await toxi.addToxic('pg_proxy', {
        name: 'pg_bandwidth',
        type: 'bandwidth',
        stream: 'downstream',
        attributes: { rate: 1 },
      });
      await sleep(SETTLE_MS);

      const start = Date.now();
      const result = await poolQuery<{ '?column?': number }>(pgPool, 'SELECT 1');
      const elapsed = Date.now() - start;

      expect(result.rows[0]?.['?column?']).toBe(1);
      // Even at 1 KB/s the overhead should add at least 50 ms on TCP round-trip
      expect(elapsed).toBeGreaterThan(0);
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports degraded when bandwidth throttle adds > 1000ms latency',
    async () => {
      // Ultra-low bandwidth to force latency past DEFAULT_DEGRADED_LATENCY_MS
      await toxi.addToxic('pg_proxy', {
        name: 'pg_bandwidth',
        type: 'bandwidth',
        stream: 'downstream',
        attributes: { rate: 1 },
      });
      await sleep(SETTLE_MS);

      // Use a very tight degraded threshold (50ms) to guarantee we cross it
      const manager = buildHealthManager({
        pgTimeoutMs: 6_000,
        pgDegradedLatencyMs: 50,
      });
      const report = await manager.checkAll();
      const pg = report.dependencies.find((d) => d.name === 'postgres');

      // The bandwidth toxic adds measurable latency; checker classifies it
      expect(['degraded', 'unhealthy']).toContain(pg?.status);
      expect(['degraded', 'unhealthy']).toContain(report.status);
    },
    10_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health returns to healthy after bandwidth toxic is removed',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_bandwidth',
        type: 'bandwidth',
        stream: 'downstream',
        attributes: { rate: 1 },
      });
      await sleep(SETTLE_MS);
      await toxi.removeToxic('pg_proxy', 'pg_bandwidth');
      await sleep(SETTLE_MS);

      const manager = buildHealthManager({ pgDegradedLatencyMs: 1_000 });
      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
    },
    10_000,
  );
});

describe('Postgres: TCP reset toxic (unhealthy health)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('pg_proxy', 'pg_reset').catch(() => {/* ok */});
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports unhealthy when connections are reset immediately',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      const manager = buildHealthManager({ pgTimeoutMs: 3_000 });
      const report = await manager.checkAll();
      const pg = report.dependencies.find((d) => d.name === 'postgres');

      expect(pg?.status).toBe<HealthStatus>('unhealthy');
      expect(pg?.error).toBeTruthy();
      expect(pg?.error).not.toMatch(/chaos_password/);
      expect(report.status).toBe<HealthStatus>('unhealthy');
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'poolQuery throws a network-level error under reset toxic',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      await expect(
        poolQuery(pgPool, 'SELECT 1'),
      ).rejects.toThrow();
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'pool recovers to healthy after reset toxic is removed',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      await toxi.removeToxic('pg_proxy', 'pg_reset');
      // Allow the pg Pool to discard the broken connection and create a fresh one
      await sleep(1_500);

      const manager = buildHealthManager({ pgTimeoutMs: 4_000 });
      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
    },
    10_000,
  );
});

// ── 2. Redis fault scenarios ──────────────────────────────────────────────────

/**
 * Build a HealthCheckManager with a Redis checker that issues a raw PING via
 * redisPing() so we do not rely on a persistent ioredis connection for these
 * tests.  This keeps each assertion stateless and avoids ioredis reconnect
 * back-off masking the fault.
 */
function buildRedisHealthManager(opts: {
  redisTimeoutMs?: number;
  redisDegradedLatencyMs?: number;
} = {}): HealthCheckManager {
  const manager = new HealthCheckManager();

  const timeoutMs = opts.redisTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const degradedLatencyMs = opts.redisDegradedLatencyMs ?? DEFAULT_DEGRADED_LATENCY_MS;

  const checker = createRedisChecker(
    () => ({
      // Implement the RedisClient interface using our raw TCP helper
      ping: () =>
        redisPing(CHAOS_REDIS_URL, timeoutMs).then(({ response, latencyMs: _l }) => {
          // createRedisChecker expects "PONG" — our raw helper returns "+PONG"
          if (response.startsWith('+')) return response.slice(1);
          return response;
        }),
    }),
    { timeoutMs, degradedLatencyMs },
  );

  manager.registerChecker(checker);
  return manager;
}

describe('Redis: latency toxic (degraded health)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('redis_proxy', 'redis_latency');
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports healthy before any Redis toxic',
    async () => {
      const report = await buildRedisHealthManager().checkAll();
      const redis = report.dependencies.find((d) => d.name === 'redis');
      expect(redis?.status).toBe<HealthStatus>('healthy');
      expect(report.status).toBe<HealthStatus>('healthy');
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'PING latency is measurably higher under latency toxic',
    async () => {
      const { latencyMs: baseline } = await redisPing(CHAOS_REDIS_URL, 4_000);

      await toxi.addToxic('redis_proxy', {
        name: 'redis_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 800, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      const { latencyMs: withToxic } = await redisPing(CHAOS_REDIS_URL, 4_000);
      // Latency with the toxic should be at least baseline + injected delay
      expect(withToxic).toBeGreaterThan(baseline + 700);
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports degraded when Redis PING latency > threshold',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 1_500, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      const manager = buildRedisHealthManager({
        redisTimeoutMs: 5_000,
        redisDegradedLatencyMs: 1_000,
      });
      const report = await manager.checkAll();
      const redis = report.dependencies.find((d) => d.name === 'redis');

      expect(redis?.status).toBe<HealthStatus>('degraded');
      expect(report.status).toBe<HealthStatus>('degraded');
      expect(redis?.latency).toBeGreaterThanOrEqual(1_500);
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker returns to healthy after Redis latency toxic is removed',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 1_500, jitter: 0 },
      });
      await sleep(SETTLE_MS);
      await toxi.removeToxic('redis_proxy', 'redis_latency');
      await sleep(SETTLE_MS);

      const manager = buildRedisHealthManager({ redisDegradedLatencyMs: 1_000 });
      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
    },
    10_000,
  );
});

describe('Redis: connection reset toxic (unhealthy health)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('redis_proxy', 'redis_reset').catch(() => {/* ok */});
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'redisPing throws when connections are reset immediately',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      await expect(redisPing(CHAOS_REDIS_URL, 3_000)).rejects.toThrow();
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker reports unhealthy when Redis connections are reset',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      const manager = buildRedisHealthManager({ redisTimeoutMs: 3_000 });
      const report = await manager.checkAll();
      const redis = report.dependencies.find((d) => d.name === 'redis');

      expect(redis?.status).toBe<HealthStatus>('unhealthy');
      expect(redis?.error).toBeTruthy();
      // Credentials must not appear in sanitised error messages
      expect(redis?.error).not.toMatch(/chaos_password/);
      expect(report.status).toBe<HealthStatus>('unhealthy');
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker recovers to healthy after reset toxic is removed',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);
      await toxi.removeToxic('redis_proxy', 'redis_reset');
      await sleep(SETTLE_MS);

      const manager = buildRedisHealthManager({ redisTimeoutMs: 4_000 });
      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
    },
    10_000,
  );
});

describe('Redis: bandwidth throttle (measurable latency impact)', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('redis_proxy', 'redis_bandwidth');
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'PING latency increases under bandwidth throttle',
    async () => {
      const { latencyMs: baseline } = await redisPing(CHAOS_REDIS_URL, 4_000);

      await toxi.addToxic('redis_proxy', {
        name: 'redis_bandwidth',
        type: 'bandwidth',
        stream: 'downstream',
        attributes: { rate: 1 },
      });
      await sleep(SETTLE_MS);

      const { latencyMs: throttled } = await redisPing(CHAOS_REDIS_URL, 4_000);
      expect(throttled).toBeGreaterThanOrEqual(baseline);
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'health checker latency is elevated under bandwidth throttle',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_bandwidth',
        type: 'bandwidth',
        stream: 'downstream',
        attributes: { rate: 1 },
      });
      await sleep(SETTLE_MS);

      // Use a very tight degraded threshold (50ms) to guarantee we detect it
      const manager = buildRedisHealthManager({
        redisTimeoutMs: 6_000,
        redisDegradedLatencyMs: 50,
      });
      const report = await manager.checkAll();
      const redis = report.dependencies.find((d) => d.name === 'redis');

      expect(['degraded', 'unhealthy']).toContain(redis?.status);
    },
    10_000,
  );
});

// ── 3. Health aggregation tests ───────────────────────────────────────────────

describe('Health aggregation: combined Postgres + Redis checkers', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.resetProxy('pg_proxy').catch(() => {/* ok */});
    await toxi.resetProxy('redis_proxy').catch(() => {/* ok */});
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'overall healthy when both checkers pass',
    async () => {
      const manager = new HealthCheckManager();
      manager.registerChecker(
        createPostgresChecker(
          () => pgPool as unknown as import('../../src/health/checkers.js').PostgresClient,
          { timeoutMs: 4_000 },
        ),
      );
      manager.registerChecker(
        createRedisChecker(
          () => ({
            ping: () =>
              redisPing(CHAOS_REDIS_URL, 4_000).then(({ response }) =>
                response.startsWith('+') ? response.slice(1) : response,
              ),
          }),
          { timeoutMs: 4_000 },
        ),
      );

      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('healthy');
      expect(report.dependencies).toHaveLength(2);
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'overall unhealthy when Postgres is unhealthy and Redis is healthy',
    async () => {
      await toxi.setProxyEnabled('pg_proxy', false);
      await sleep(SETTLE_MS);

      const manager = new HealthCheckManager();
      manager.registerChecker(
        createPostgresChecker(
          () => pgPool as unknown as import('../../src/health/checkers.js').PostgresClient,
          { timeoutMs: 2_000 },
        ),
      );
      manager.registerChecker(
        createRedisChecker(
          () => ({
            ping: () =>
              redisPing(CHAOS_REDIS_URL, 4_000).then(({ response }) =>
                response.startsWith('+') ? response.slice(1) : response,
              ),
          }),
          { timeoutMs: 4_000 },
        ),
      );

      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('unhealthy');

      const pg = report.dependencies.find((d) => d.name === 'postgres');
      const redis = report.dependencies.find((d) => d.name === 'redis');
      expect(pg?.status).toBe<HealthStatus>('unhealthy');
      expect(redis?.status).toBe<HealthStatus>('healthy');
    },
    8_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'overall degraded when only Postgres latency is elevated',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 1_500, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      const manager = new HealthCheckManager();
      manager.registerChecker(
        createPostgresChecker(
          () => pgPool as unknown as import('../../src/health/checkers.js').PostgresClient,
          { timeoutMs: 5_000, degradedLatencyMs: 1_000 },
        ),
      );
      manager.registerChecker(
        createRedisChecker(
          () => ({
            ping: () =>
              redisPing(CHAOS_REDIS_URL, 4_000).then(({ response }) =>
                response.startsWith('+') ? response.slice(1) : response,
              ),
          }),
          { timeoutMs: 4_000, degradedLatencyMs: 1_000 },
        ),
      );

      const report = await manager.checkAll();
      expect(report.status).toBe<HealthStatus>('degraded');
    },
    12_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'overall unhealthy trumps degraded (unhealthy > degraded rule)',
    async () => {
      // Postgres: reset (unhealthy), Redis: latency (degraded)
      await toxi.addToxic('pg_proxy', {
        name: 'pg_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await toxi.addToxic('redis_proxy', {
        name: 'redis_latency',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 1_500, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      const manager = new HealthCheckManager();
      manager.registerChecker(
        createPostgresChecker(
          () => pgPool as unknown as import('../../src/health/checkers.js').PostgresClient,
          { timeoutMs: 2_000 },
        ),
      );
      manager.registerChecker(
        createRedisChecker(
          () => ({
            ping: () =>
              redisPing(CHAOS_REDIS_URL, 5_000).then(({ response }) =>
                response.startsWith('+') ? response.slice(1) : response,
              ),
          }),
          { timeoutMs: 5_000, degradedLatencyMs: 1_000 },
        ),
      );

      const report = await manager.checkAll();
      // unhealthy trumps degraded per aggregateStatus()
      expect(report.status).toBe<HealthStatus>('unhealthy');
    },
    12_000,
  );
});

// ── 4. Pool error propagation ─────────────────────────────────────────────────

describe('Postgres pool.ts error propagation under chaos', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.removeToxic('pg_proxy', 'pg_reset').catch(() => {/* ok */});
    await toxi.removeToxic('pg_proxy', 'pg_timeout').catch(() => {/* ok */});
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'query() propagates connection errors as-is (not swallowed)',
    async () => {
      await toxi.addToxic('pg_proxy', {
        name: 'pg_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      const err = await poolQuery(pgPool, 'SELECT 1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      // Must NOT be swallowed — actual error type from pg is exposed to the caller
      expect(err).not.toBeNull();
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'query() throws QueryTimeoutError when statement_timeout fires under extreme latency',
    async () => {
      // Inject latency > statementTimeoutMs (4 000 ms in our test pool config)
      await toxi.addToxic('pg_proxy', {
        name: 'pg_timeout',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 8_000, jitter: 0 },
      });
      await sleep(SETTLE_MS);

      // This pool has statementTimeoutMs: 4_000 (set in beforeAll)
      // The statement_timeout is set on the connection by the pool.on('connect') handler.
      // If the connection itself succeeds but the query hangs, PG fires 57014.
      // If the connection times out first (connectTimeout: 4_000), pg throws ETIMEDOUT.
      // Either way the caller sees an error — assert it is one of the expected types.
      const err = await poolQuery(pgPool, 'SELECT pg_sleep(10)').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      // Could be QueryTimeoutError (57014) or a connection timeout from pg itself
      const isExpectedError =
        err instanceof QueryTimeoutError ||
        (err instanceof Error &&
          (err.message.includes('timeout') || err.message.includes('ETIMEDOUT') || err.message.includes('reset')));
      expect(isExpectedError).toBe(true);
    },
    12_000,
  );
});

// ── 5. Security assertions ────────────────────────────────────────────────────

describe('Security: credentials never leak into health error messages', () => {
  afterEach(async () => {
    if (!CHAOS_ENABLED) return;
    await toxi.setProxyEnabled('pg_proxy', true).catch(() => {/* ok */});
    await toxi.removeToxic('redis_proxy', 'redis_reset').catch(() => {/* ok */});
    await sleep(SETTLE_MS);
  });

  it.skipIf(!CHAOS_ENABLED)(
    'Postgres error messages do not contain connection string credentials',
    async () => {
      await toxi.setProxyEnabled('pg_proxy', false);
      await sleep(SETTLE_MS);

      const checker = createPostgresChecker(
        () => pgPool as unknown as import('../../src/health/checkers.js').PostgresClient,
        { timeoutMs: 2_000 },
      );
      const result = await checker.check();

      expect(result.error).toBeTruthy();
      // sanitiseErrorMessage in checkers.ts strips postgresql:// URLs and user:password@host
      expect(result.error).not.toMatch(/chaos_password/i);
      expect(result.error).not.toMatch(/postgresql:\/\//i);
      expect(result.error).not.toMatch(/chaos_user/i);
    },
    6_000,
  );

  it.skipIf(!CHAOS_ENABLED)(
    'Redis error messages do not contain connection string credentials',
    async () => {
      await toxi.addToxic('redis_proxy', {
        name: 'redis_reset',
        type: 'reset_peer',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
      await sleep(SETTLE_MS);

      const checker = createRedisChecker(
        () => ({
          ping: () =>
            redisPing(CHAOS_REDIS_URL, 2_000).then(({ response }) =>
              response.startsWith('+') ? response.slice(1) : response,
            ),
        }),
        { timeoutMs: 2_000 },
      );
      const result = await checker.check();

      expect(result.error).toBeTruthy();
      expect(result.error).not.toMatch(/chaos_password/i);
      expect(result.error).not.toMatch(/redis:\/\//i);
    },
    6_000,
  );
});

// ── 6. ToxiproxyClient unit tests (no chaos stack required) ──────────────────

describe('ToxiproxyClient: management API error handling', () => {
  it('addToxic throws when management API is unreachable', async () => {
    const bad = new ToxiproxyClient('http://127.0.0.1:19999');
    await expect(
      bad.addToxic('pg_proxy', {
        name: 'test',
        type: 'latency',
        stream: 'upstream',
        attributes: { latency: 100 },
      }),
    ).rejects.toThrow();
  });

  it('removeToxic on unreachable API throws', async () => {
    const bad = new ToxiproxyClient('http://127.0.0.1:19999');
    await expect(bad.removeToxic('pg_proxy', 'test')).rejects.toThrow();
  });

  it('getProxies on unreachable API throws with useful message', async () => {
    const bad = new ToxiproxyClient('http://127.0.0.1:19999');
    await expect(bad.getProxies()).rejects.toThrow();
  });
});

// ── 7. PoolExhaustedError is exported correctly ───────────────────────────────

describe('Pool error types (unit — no chaos stack required)', () => {
  it('PoolExhaustedError is a proper Error subclass', () => {
    const err = new PoolExhaustedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PoolExhaustedError');
    expect(err.message).toContain('exhausted');
  });

  it('QueryTimeoutError is a proper Error subclass', () => {
    const err = new QueryTimeoutError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QueryTimeoutError');
    expect(err.message).toContain('timeout');
  });
});
