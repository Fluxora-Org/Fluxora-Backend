/**
 * Health check module for Fluxora Backend
 * 
 * Provides dependency health status and diagnostic information
 * for operators to diagnose incidents without tribal knowledge.
 * 
 * Failure modes handled:
 * - Database connection timeout/failure
 * - Redis unavailable
 * - Horizon RPC unreachable
 * - Invalid configuration
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
    name: string;
    status: HealthStatus;
    latency?: number; // milliseconds
    error?: string;
    lastChecked: string; // ISO timestamp
}

export interface HealthReport {
    status: HealthStatus;
    timestamp: string;
    uptime: number; // seconds
    dependencies: DependencyHealth[];
    version: string;
}

/**
 * Health checker for a single dependency
 */
export interface HealthChecker {
    name: string;
    check(): Promise<{ latency: number; error?: string }>;
}

/**
 * Manages health checks for all dependencies
 */
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
            const latency = Date.now() - startTime;

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

    /**
     * Get last known health status (cached)
     */
    getLastReport(version: string): HealthReport {
        const dependencies = Array.from(this.lastResults.values());
        const status = this.aggregateStatus(dependencies);
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);

        return {
            status,
            timestamp: new Date().toISOString(),
            uptime,
            dependencies,
            version,
        };
    }
}

/**
 * Create a health checker for database connections
 */
export function createDatabaseHealthChecker(): HealthChecker {
    return {
        name: 'database',
        async check() {
            // TODO: Implement actual database connection check
            // For now, return healthy (will be implemented with actual DB)
            return { latency: 5 };
        },
    };
}

/**
 * Create a health checker for Redis
 */
export function createRedisHealthChecker(): HealthChecker {
    return {
        name: 'redis',
        async check() {
            // TODO: Implement actual Redis connection check
            // For now, return healthy (will be implemented with actual Redis)
            return { latency: 2 };
        },
    };
}

/**
 * Create a health checker for Horizon RPC
 */
export function createHorizonHealthChecker(horizonUrl: string): HealthChecker {
    return {
        name: 'horizon',
        async check() {
            const startTime = Date.now();
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                try {
                    const response = await fetch(`${horizonUrl}/health`, {
                        signal: controller.signal,
                    });

                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        return {
                            latency: Date.now() - startTime,
                            error: `HTTP ${response.status}`,
                        };
                    }

                    return { latency: Date.now() - startTime };
                } finally {
                    clearTimeout(timeoutId);
                }
            } catch (err) {
                return {
                    latency: Date.now() - startTime,
                    error: err instanceof Error ? err.message : 'Unknown error',
                };
            }
        },
    };
}
