export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  name: string;
  status: HealthStatus;
  latency?: number;
  error?: string;
  lastChecked: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  timestamp: string;
  uptime: number;
  dependencies: DependencyHealth[];
}

export interface HealthChecker {
  name: string;
  check(): Promise<{ latency: number; error?: string }>;
}

export class HealthCheckManager {
  private checkers: Map<string, HealthChecker> = new Map();
  private lastResults: Map<string, DependencyHealth> = new Map();
  private startTime = Date.now();

  registerChecker(checker: HealthChecker): void {
    this.checkers.set(checker.name, checker);
    this.lastResults.set(checker.name, {
      name: checker.name,
      status: 'healthy',
      lastChecked: new Date().toISOString(),
    });
  }

  async checkAll(): Promise<HealthReport> {
    const results = await Promise.all(
      Array.from(this.checkers.values()).map((checker) => this.checkOne(checker))
    );

    const status = this.aggregateStatus(results);
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      status,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime,
      dependencies: results,
    };
  }

  getLastReport(version = '0.1.0'): HealthReport {
    const results = Array.from(this.lastResults.values());
    return {
      status: this.aggregateStatus(results),
      version,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      dependencies: results,
    };
  }

  private async checkOne(checker: HealthChecker): Promise<DependencyHealth> {
    const startTime = Date.now();

    try {
      const result = await checker.check();
      const latency = result.latency ?? Date.now() - startTime;
      const health: DependencyHealth = {
        name: checker.name,
        status: result.error ? 'unhealthy' : 'healthy',
        latency,
        error: result.error,
        lastChecked: new Date().toISOString(),
      };

      this.lastResults.set(checker.name, health);
      return health;
    } catch (err) {
      const latency = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);

      const health: DependencyHealth = {
        name: checker.name,
        status: 'unhealthy',
        latency,
        error,
        lastChecked: new Date().toISOString(),
      };

      this.lastResults.set(checker.name, health);
      return health;
    }
  }

  private aggregateStatus(dependencies: DependencyHealth[]): HealthStatus {
    if (dependencies.some((dependency) => dependency.status === 'unhealthy')) {
      return 'unhealthy';
    }

    if (dependencies.some((dependency) => dependency.status === 'degraded')) {
      return 'degraded';
    }

    return 'healthy';
  }
}

export function createDatabaseHealthChecker(): HealthChecker {
  return {
    name: 'database',
    async check() {
      return { latency: 1 };
    },
  };
}

export function createRedisHealthChecker(): HealthChecker {
  return {
    name: 'redis',
    async check() {
      return { latency: 1 };
    },
  };
}

export function createHorizonHealthChecker(_url: string): HealthChecker {
  return {
    name: 'horizon',
    async check() {
      return { latency: 1 };
    },
  };
}
