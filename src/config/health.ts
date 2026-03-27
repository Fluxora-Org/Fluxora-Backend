export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
    name: string;
    status: HealthStatus;
    latency?: number; // milliseconds
    error?: string | undefined;
    lastChecked: string; // ISO timestamp
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  timestamp: string;
  uptime: number;
  /** Flat map: dependencyName → status string, e.g. { postgres: "healthy" } */
  dependencies: Record<string, string>;
}

export interface HealthChecker {
  name: string;
  check(): Promise<{ latency: number; error?: string }>;
}

export class HealthCheckManager {
    private checkers: Map<string, HealthChecker> = new Map();
    private lastResults: Map<string, DependencyHealth> = new Map();
    private startTime: number = Date.now();

    /**
     * Register a health checker for a dependency
     */
    registerChecker(checker: HealthChecker): void {
        this.checkers.set(checker.name, checker);
        this.lastResults.set(checker.name, {
            name: checker.name,
            status: 'healthy',
            lastChecked: new Date().toISOString(),
        });
    }

    /**
     * Run all health checks
     */
    async checkAll(): Promise<HealthReport> {
        const results = await Promise.all(
            Array.from(this.checkers.values()).map((checker) => this.checkOne(checker))
        );

        const dependencies = results;
        const status = this.aggregateStatus(dependencies);
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);

        return {
            status,
            timestamp: new Date().toISOString(),
            uptime,
            dependencies,
            version: '0.1.0',
        };
    }

    /**
     * Run a single health check
     */
    private async checkOne(checker: HealthChecker): Promise<DependencyHealth> {
        const startTime = Date.now();
        try {
            const result = await checker.check();
            // Use checker-reported latency when provided; fall back to wall-clock measurement
            const latency = result.latency ?? (Date.now() - startTime);

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

    /**
     * Aggregate dependency statuses into overall health
     */
    private aggregateStatus(dependencies: DependencyHealth[]): HealthStatus {
        const statuses = dependencies.map((d) => d.status);

        if (statuses.includes('unhealthy')) {
            return 'unhealthy';
        }

        if (statuses.includes('degraded')) {
            return 'degraded';
        }

        return 'healthy';
    }
  }

  private aggregateStatus(deps: DependencyHealth[]): HealthStatus {
    if (deps.some((d) => d.status === 'unhealthy')) return 'unhealthy';
    if (deps.some((d) => d.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private buildReport(deps: DependencyHealth[], version: string): HealthReport {
    const dependenciesMap: Record<string, string> = {};
    for (const d of deps) {
      dependenciesMap[d.name] = d.status;
    }
    return {
      status: this.aggregateStatus(deps),
      version,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      dependencies: dependenciesMap,
    };
  }

  getLastReport(version = '0.1.0'): HealthReport {
    return this.buildReport(Array.from(this.lastResults.values()), version);
  }
}
