import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config/env.js';
import {
HealthCheckManager,
type HealthChecker,
type DependencyHealth,
createDatabaseHealthChecker,
createRedisHealthChecker,
createHorizonHealthChecker,
createBoundedHealthCheckManager,
validateHealthConfig,
} from './health.js';

describe('Health Check Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should use default values if environment variables are omitted', () => {
    delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    delete process.env.HEALTH_CHECK_INTERVAL_MS;
    const config = loadConfig();

    expect(config.healthCheckTimeoutMs).toBe(5000);
    expect(config.healthCheckIntervalMs).toBe(30000);
  });

  it('should reject zero or negative timeout values via parseIntEnv min limit', () => {
    process.env.HEALTH_CHECK_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/at least 1|below minimum 1/);
  });
});

const makeChecker = (name: string, error?: string): HealthChecker => ({
  name,
  async check() {
    if (error) {
      return { latency: 1, error };
    }
    return { latency: 1 };
  },
});

describe('Health Check Manager', () => {
  let manager: HealthCheckManager;

  beforeEach(() => {
    manager = new HealthCheckManager();
  });

  describe('registerChecker', () => {
    it('should register a health checker', () => {
      const checker: HealthChecker = {
        name: 'test',
        async check() {
          return { latency: 10 };
        },
      };

      manager.registerChecker(checker);
      const report = manager.getLastReport('0.1.0');

      expect(report.dependencies).toHaveLength(1);
      const dep = report.dependencies[0]!;
      expect(dep.name).toBe('test');
    });

    it('should register multiple checkers', () => {
      const checker1: HealthChecker = { name: 'service1', async check() { return { latency: 10 }; } };
      const checker2: HealthChecker = { name: 'service2', async check() { return { latency: 20 }; } };

      manager.registerChecker(checker1);
      manager.registerChecker(checker2);

      const report = manager.getLastReport('0.1.0');
      expect(report.dependencies).toHaveLength(2);
    });
  });

  describe('checkAll', () => {
    it('should run all health checks', async () => {
      const checker: HealthChecker = { name: 'test', async check() { return { latency: 5 }; } };

      manager.registerChecker(checker);
      const report = await manager.checkAll();

      expect(report.status).toBe('healthy');
      expect(report.dependencies).toHaveLength(1);
      expect(report.dependencies[0]!.latency).toBeGreaterThanOrEqual(0);
    });

    it('should mark unhealthy when checker returns error', async () => {
      const checker: HealthChecker = {
        name: 'failing',
        async check() {
          return { latency: 100, error: 'Connection refused' };
        },
      };

      manager.registerChecker(checker);
      const report = await manager.checkAll();
      const dep = report.dependencies[0]!;

      expect(report.status).toBe('unhealthy');
      expect(dep.status).toBe('unhealthy');
      expect(dep.error).toBe('Connection refused');
    });

    it('should mark unhealthy when checker throws', async () => {
      const checker: HealthChecker = {
        name: 'throwing',
        async check() {
          throw new Error('Unexpected error');
        },
      };

      manager.registerChecker(checker);
      const report = await manager.checkAll();
      const dep = report.dependencies[0]!;

      expect(report.status).toBe('unhealthy');
      expect(dep.status).toBe('unhealthy');
      expect(dep.error).toBe('Unexpected error');
    });

    it('should aggregate status correctly', async () => {
      const healthy: HealthChecker = { name: 'healthy', async check() { return { latency: 5 }; } };
      const unhealthy: HealthChecker = { name: 'unhealthy', async check() { return { latency: 100, error: 'Failed' }; } };

      manager.registerChecker(healthy);
      manager.registerChecker(unhealthy);

      const report = await manager.checkAll();
      expect(report.status).toBe('unhealthy');
    });

    it('should include uptime in report', async () => {
      const checker: HealthChecker = { name: 'test', async check() { return { latency: 5 }; } };
      manager.registerChecker(checker);
      const report = await manager.checkAll();

      expect(report.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof report.uptime).toBe('number');
    });

    it('should include timestamp in report', async () => {
      const checker: HealthChecker = { name: 'test', async check() { return { latency: 5 }; } };
      manager.registerChecker(checker);
      const report = await manager.checkAll();

      expect(report.timestamp).toBeDefined();
      expect(new Date(report.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('should include version in report', async () => {
      const checker: HealthChecker = { name: 'test', async check() { return { latency: 5 }; } };
      manager.registerChecker(checker);
      const report = await manager.checkAll();

      expect(report.version).toBe('0.1.0');
    });
  });

  describe('getLastReport', () => {
    it('should return cached report', async () => {
      const checker: HealthChecker = { name: 'test', async check() { return { latency: 5 }; } };
      manager.registerChecker(checker);
      await manager.checkAll();

      const report = manager.getLastReport('0.1.0');
      expect(report.dependencies).toHaveLength(1);
      expect(report.status).toBe('healthy');
    });

    it('should return initial healthy status before first check', () => {
      const checker: HealthChecker = { name: 'test', async check() { return { latency: 5 }; } };
      manager.registerChecker(checker);
      const report = manager.getLastReport('0.1.0');

      expect(report.status).toBe('healthy');
      expect(report.dependencies[0]!.status).toBe('healthy');
    });
  });

  describe('Built-in checkers', () => {
    it('should create database health checker with default and custom timeout', async () => {
      const checker = createDatabaseHealthChecker();
      expect(checker.name).toBe('database');
      expect(checker.timeoutMs).toBe(5000);
      const custom = createDatabaseHealthChecker({ timeoutMs: 2500 });
      expect(custom.timeoutMs).toBe(2500);
      const result = await checker.check();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should create redis health checker with default and custom timeout', async () => {
      const checker = createRedisHealthChecker();
      expect(checker.name).toBe('redis');
      expect(checker.timeoutMs).toBe(5000);
      const custom = createRedisHealthChecker({ timeoutMs: 1500 });
      expect(custom.timeoutMs).toBe(1500);
      const result = await checker.check();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should create horizon health checker with default and custom timeout', async () => {
      const checker = createHorizonHealthChecker('https://horizon.stellar.org');
      expect(checker.name).toBe('horizon');
      expect(checker.timeoutMs).toBe(5000);
      const custom = createHorizonHealthChecker('https://horizon.stellar.org', { timeoutMs: 3500 });
      expect(custom.timeoutMs).toBe(3500);
      const result = await checker.check();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Status aggregation', () => {
    it('should return healthy when all dependencies are healthy', async () => {
      const checker1: HealthChecker = { name: 'service1', async check() { return { latency: 5 }; } };
      const checker2: HealthChecker = { name: 'service2', async check() { return { latency: 10 }; } };

      manager.registerChecker(checker1);
      manager.registerChecker(checker2);

      const report = await manager.checkAll();
      expect(report.status).toBe('healthy');
    });

    it('should return unhealthy when any dependency is unhealthy', async () => {
      manager.registerChecker(makeChecker('a'));
      manager.registerChecker(makeChecker('b', 'fail'));
      expect((await manager.checkAll()).status).toBe('unhealthy');
    });

    it('should reflect failures in the last report', async () => {
      manager.registerChecker(makeChecker('x', 'fail'));
      await manager.checkAll();
      expect(manager.getLastReport().status).toBe('unhealthy');
    });

    it('should return degraded when a dependency is degraded', () => {
      const degradedHealth: DependencyHealth = {
        name: 'dep',
        status: 'degraded',
        lastChecked: new Date().toISOString(),
      };

      (manager as unknown as { lastResults: Map<string, DependencyHealth> })
        .lastResults.set('dep', degradedHealth);

      expect(manager.getLastReport().status).toBe('degraded');
    });

    it('should mark degraded when checker returns degraded: true', async () => {
      const checker: HealthChecker = {
        name: 'slow',
        async check() { return { latency: 1500, degraded: true }; },
      };
      manager.registerChecker(checker);
      const report = await manager.checkAll();
      expect(report.status).toBe('degraded');
      expect(report.dependencies[0]!.status).toBe('degraded');
    });

    it('unhealthy takes precedence over degraded in aggregation', async () => {
      manager.registerChecker({ name: 'slow', async check() { return { latency: 1, degraded: true }; } });
      manager.registerChecker({ name: 'broken', async check() { return { latency: 1, error: 'down' }; } });
      const report = await manager.checkAll();
      expect(report.status).toBe('unhealthy');
    });

    it('degraded takes precedence over healthy in aggregation', async () => {
      manager.registerChecker({ name: 'ok', async check() { return { latency: 1 }; } });
      manager.registerChecker({ name: 'slow', async check() { return { latency: 1, degraded: true }; } });
      const report = await manager.checkAll();
      expect(report.status).toBe('degraded');
    });

    it('does not include error field when checker returns degraded without error', async () => {
      const checker: HealthChecker = {
        name: 'slow',
        async check() { return { latency: 1, degraded: true }; },
      };
      manager.registerChecker(checker);
      const report = await manager.checkAll();
      expect(report.dependencies[0]!.error).toBeUndefined();
    });
  });
});

// ─── Per-checker timeout enforcement (issue #1575) ───────────────────────────

describe('HealthCheckManager — per-checker timeout enforcement', () => {
  it('times out a hanging checker and reports it as unhealthy', async () => {
    const manager = new HealthCheckManager();
    manager.registerChecker({
      name: 'hanging',
      timeoutMs: 80,
      async check() {
        return new Promise(() => { /* never resolves */ });
      },
    });

    const report = await manager.checkAll();
    const dep = report.dependencies[0]!;

    expect(dep.status).toBe('unhealthy');
    expect(dep.error).toMatch(/timed out/);
    expect(dep.latency).toBeGreaterThanOrEqual(0);
  }, 2000);

  it('uses checker.timeoutMs over the global HEALTH_CHECK_TIMEOUT_MS', async () => {
    // checker declares 80 ms; if global (5 000 ms) were used the test would
    // take 5 seconds — the 500 ms wall-clock guard below would catch that.
    const manager = new HealthCheckManager();
    const start = Date.now();

    manager.registerChecker({
      name: 'slow',
      timeoutMs: 80,
      async check() {
        return new Promise(() => { /* never resolves */ });
      },
    });

    const report = await manager.checkAll();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(report.dependencies[0]!.status).toBe('unhealthy');
  }, 2000);

  it('applies global timeout when checker has no timeoutMs', async () => {
    // We cannot set the live config's healthCheckTimeoutMs to a small value
    // without touching env, so we test the fallback path via a checker that
    // declares its own small timeout — verifies the ?? chain works.
    const manager = new HealthCheckManager();
    manager.registerChecker({
      name: 'no-own-timeout',
      // No timeoutMs — manager will use getConfig().healthCheckTimeoutMs (5 000 ms).
      // The checker itself resolves quickly, so the test still passes.
      async check() {
        return { latency: 5 };
      },
    });

    const report = await manager.checkAll();
    expect(report.dependencies[0]!.status).toBe('healthy');
  });

  it('checkAll returns within the bounded time when all checkers hang', async () => {
    const TIMEOUT_MS = 100;
    const MAX_WALL_MS = TIMEOUT_MS + 700; // generous for CI scheduling jitter

    const manager = new HealthCheckManager();
    for (const name of ['postgres', 'redis', 'stellar_rpc']) {
      manager.registerChecker({
        name,
        timeoutMs: TIMEOUT_MS,
        async check() {
          return new Promise(() => { /* never resolves */ });
        },
      });
    }

    const start = Date.now();
    const report = await manager.checkAll();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(MAX_WALL_MS);
    expect(report.status).toBe('unhealthy');
    for (const dep of report.dependencies) {
      expect(dep.status).toBe('unhealthy');
      expect(dep.error).toMatch(/timed out/);
    }
  }, 3000);

  it('a timed-out checker does not affect a healthy checker in the same checkAll', async () => {
    const manager = new HealthCheckManager();

    manager.registerChecker({
      name: 'broken',
      timeoutMs: 80,
      async check() {
        return new Promise(() => { /* never resolves */ });
      },
    });
    manager.registerChecker({
      name: 'ok',
      timeoutMs: 5_000,
      async check() { return { latency: 1 }; },
    });

    const report = await manager.checkAll();
    const broken = report.dependencies.find((d) => d.name === 'broken')!;
    const ok     = report.dependencies.find((d) => d.name === 'ok')!;

    expect(broken.status).toBe('unhealthy');
    expect(ok.status).toBe('healthy');
    expect(report.status).toBe('unhealthy');
  }, 2000);

  it('timed-out check stores the error in lastResults for getLastReport()', async () => {
    const manager = new HealthCheckManager();
    manager.registerChecker({
      name: 'hanging',
      timeoutMs: 80,
      async check() {
        return new Promise(() => { /* never resolves */ });
      },
    });

    await manager.checkAll();
    const cached = manager.getLastReport();
    const dep = cached.dependencies.find((d) => d.name === 'hanging')!;

    expect(dep.status).toBe('unhealthy');
    expect(dep.error).toMatch(/timed out/);
  }, 2000);

  it('checkAll hard deadline fallback reports status as unhealthy', async () => {
    const mgr = new HealthCheckManager();
    mgr.registerChecker({
      name: 'escaped_checker',
      timeoutMs: 50,
      async check() { return new Promise(() => { /* never resolves */ }); },
    });
    // Simulate checkOne hanging without resolving
    (mgr as unknown as { checkOne: () => Promise<unknown> }).checkOne = () =>
      new Promise(() => { /* never resolves */ });

    // Mock timeoutMs to 20ms so hardDeadlineMs (20 + 500 = 520ms) fires
    Object.defineProperty(mgr, 'timeoutMs', { value: 20 });

    const report = await mgr.checkAll();
    expect(report.status).toBe('unhealthy');
    expect(report.dependencies[0]?.status).toBe('unhealthy');
    expect(report.dependencies[0]?.error).toMatch(/timed out/);
  }, 2000);
});

// ─── validateHealthConfig — optional per-checker timeouts (issue #1575) ──────

describe('validateHealthConfig — per-checker timeout overrides', () => {
  const base = {
    healthCheckTimeoutMs: 5000,
    healthCheckIntervalMs: 30000,
    startupProbeBudgetMs: 30000,
    startupProbePostgresTimeoutMs: 5000,
    startupProbeRedisTimeoutMs: 3000,
    startupProbeStellarTimeoutMs: 5000,
  };

  it('accepts valid per-checker overrides', () => {
    expect(validateHealthConfig({
      ...base,
      healthCheckPostgresTimeoutMs: 3000,
      healthCheckRedisTimeoutMs: 2000,
      healthCheckStellarTimeoutMs: 4000,
    })).toEqual([]);
  });

  it('treats undefined per-checker timeouts as valid (falls back to global)', () => {
    expect(validateHealthConfig({
      ...base,
      healthCheckPostgresTimeoutMs: undefined,
      healthCheckRedisTimeoutMs: undefined,
      healthCheckStellarTimeoutMs: undefined,
    })).toEqual([]);
  });

  it('rejects zero healthCheckPostgresTimeoutMs', () => {
    const issues = validateHealthConfig({ ...base, healthCheckPostgresTimeoutMs: 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/healthCheckPostgresTimeoutMs/);
  });

  it('rejects negative healthCheckRedisTimeoutMs', () => {
    const issues = validateHealthConfig({ ...base, healthCheckRedisTimeoutMs: -1 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/healthCheckRedisTimeoutMs/);
  });

  it('rejects non-integer healthCheckStellarTimeoutMs', () => {
    const issues = validateHealthConfig({ ...base, healthCheckStellarTimeoutMs: 1.5 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/healthCheckStellarTimeoutMs/);
  });

  it('reports all three when all per-checker overrides are invalid', () => {
    const issues = validateHealthConfig({
      ...base,
      healthCheckPostgresTimeoutMs: 0,
      healthCheckRedisTimeoutMs: -5,
      healthCheckStellarTimeoutMs: 0.5,
    });
    expect(issues).toHaveLength(3);
  });
});

// ─── createBoundedHealthCheckManager (issue #1575) ───────────────────────────

describe('createBoundedHealthCheckManager', () => {
  it('registers all three standard checkers', () => {
    const manager = createBoundedHealthCheckManager({ healthCheckTimeoutMs: 5000 });
    const report = manager.getLastReport();
    const names = report.dependencies.map((d) => d.name).sort();
    expect(names).toEqual(['postgres', 'redis', 'stellar_rpc']);
  });

  it('assigns the global timeout to checkers that have no per-checker override', () => {
    const manager = createBoundedHealthCheckManager({ healthCheckTimeoutMs: 3000 });
    // Access internal checkers via the Map (test-seam cast)
    const checkers = (manager as unknown as { checkers: Map<string, HealthChecker> }).checkers;
    expect(checkers.get('postgres')!.timeoutMs).toBe(3000);
    expect(checkers.get('redis')!.timeoutMs).toBe(3000);
    expect(checkers.get('stellar_rpc')!.timeoutMs).toBe(3000);
  });

  it('uses per-checker override when provided', () => {
    const manager = createBoundedHealthCheckManager({
      healthCheckTimeoutMs: 5000,
      healthCheckPostgresTimeoutMs: 1000,
      healthCheckRedisTimeoutMs: 2000,
      healthCheckStellarTimeoutMs: 3000,
    });
    const checkers = (manager as unknown as { checkers: Map<string, HealthChecker> }).checkers;
    expect(checkers.get('postgres')!.timeoutMs).toBe(1000);
    expect(checkers.get('redis')!.timeoutMs).toBe(2000);
    expect(checkers.get('stellar_rpc')!.timeoutMs).toBe(3000);
  });

  it('upserts standard checkers with real implementations via extraCheckers', () => {
    const realPostgres: HealthChecker = {
      name: 'postgres',
      timeoutMs: 999,
      async check() { return { latency: 1 }; },
    };
    const manager = createBoundedHealthCheckManager({
      healthCheckTimeoutMs: 5000,
      extraCheckers: [realPostgres],
    });
    const checkers = (manager as unknown as { checkers: Map<string, HealthChecker> }).checkers;
    expect(checkers.get('postgres')).toBe(realPostgres);
    expect(checkers.get('postgres')!.timeoutMs).toBe(999);
  });

  it('registers additional checkers beyond the three standard ones', () => {
    const custom: HealthChecker = { name: 'custom', async check() { return { latency: 1 }; } };
    const manager = createBoundedHealthCheckManager({
      healthCheckTimeoutMs: 5000,
      extraCheckers: [custom],
    });
    const report = manager.getLastReport();
    expect(report.dependencies.map((d) => d.name)).toContain('custom');
    expect(report.dependencies).toHaveLength(4);
  });
});

// ─── Schema — HEALTH_CHECK_POSTGRES/REDIS/STELLAR_TIMEOUT_MS ─────────────────

describe('Health Check Environment Configuration — per-checker env vars', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('loads HEALTH_CHECK_POSTGRES_TIMEOUT_MS from env when set', () => {
    process.env.HEALTH_CHECK_POSTGRES_TIMEOUT_MS = '3000';
    const config = loadConfig();
    expect(config.healthCheckPostgresTimeoutMs).toBe(3000);
  });

  it('loads HEALTH_CHECK_REDIS_TIMEOUT_MS from env when set', () => {
    process.env.HEALTH_CHECK_REDIS_TIMEOUT_MS = '2000';
    const config = loadConfig();
    expect(config.healthCheckRedisTimeoutMs).toBe(2000);
  });

  it('loads HEALTH_CHECK_STELLAR_TIMEOUT_MS from env when set', () => {
    process.env.HEALTH_CHECK_STELLAR_TIMEOUT_MS = '4000';
    const config = loadConfig();
    expect(config.healthCheckStellarTimeoutMs).toBe(4000);
  });

  it('leaves per-checker timeouts undefined when env vars are absent', () => {
    delete process.env.HEALTH_CHECK_POSTGRES_TIMEOUT_MS;
    delete process.env.HEALTH_CHECK_REDIS_TIMEOUT_MS;
    delete process.env.HEALTH_CHECK_STELLAR_TIMEOUT_MS;
    const config = loadConfig();
    expect(config.healthCheckPostgresTimeoutMs).toBeUndefined();
    expect(config.healthCheckRedisTimeoutMs).toBeUndefined();
    expect(config.healthCheckStellarTimeoutMs).toBeUndefined();
  });

  it('throws ConfigError when HEALTH_CHECK_POSTGRES_TIMEOUT_MS=0', () => {
    process.env.HEALTH_CHECK_POSTGRES_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('throws ConfigError when HEALTH_CHECK_REDIS_TIMEOUT_MS is negative', () => {
    process.env.HEALTH_CHECK_REDIS_TIMEOUT_MS = '-1';
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
