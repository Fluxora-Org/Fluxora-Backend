import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config/env.js';
import {
HealthCheckManager,
type HealthChecker,
type DependencyHealth,
createDatabaseHealthChecker,
createRedisHealthChecker,
createHorizonHealthChecker,
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
    expect(() => loadConfig()).toThrow(/below minimum 1/);
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
    it('should create database health checker', async () => {
      const checker = createDatabaseHealthChecker();
      expect(checker.name).toBe('database');
      const result = await checker.check();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should create redis health checker', async () => {
      const checker = createRedisHealthChecker();
      expect(checker.name).toBe('redis');
      const result = await checker.check();
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should create horizon health checker', async () => {
      const checker = createHorizonHealthChecker('https://horizon.stellar.org');
      expect(checker.name).toBe('horizon');
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