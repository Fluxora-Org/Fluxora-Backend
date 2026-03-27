import { describe, it, expect, beforeEach } from '@jest/globals';
import {
    HealthCheckManager,
    HealthChecker,
    HealthStatus,
    createDatabaseHealthChecker,
    createRedisHealthChecker,
    createHorizonHealthChecker,
} from './health';

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
            expect(report.dependencies[0].name).toBe('test');
        });

        it('should register multiple checkers', () => {
            const checker1: HealthChecker = {
                name: 'service1',
                async check() {
                    return { latency: 10 };
                },
            };

            const checker2: HealthChecker = {
                name: 'service2',
                async check() {
                    return { latency: 20 };
                },
            };

            manager.registerChecker(checker1);
            manager.registerChecker(checker2);

            const report = manager.getLastReport('0.1.0');
            expect(report.dependencies).toHaveLength(2);
        });
    });

    describe('checkAll', () => {
        it('should run all health checks', async () => {
            const checker: HealthChecker = {
                name: 'test',
                async check() {
                    return { latency: 5 };
                },
            };

            manager.registerChecker(checker);
            const report = await manager.checkAll();

            expect(report.status).toBe('healthy');
            expect(report.dependencies).toHaveLength(1);
            expect(report.dependencies[0].latency).toBe(5);
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

            expect(report.status).toBe('unhealthy');
            expect(report.dependencies[0].status).toBe('unhealthy');
            expect(report.dependencies[0].error).toBe('Connection refused');
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

            expect(report.status).toBe('unhealthy');
            expect(report.dependencies[0].status).toBe('unhealthy');
            expect(report.dependencies[0].error).toBe('Unexpected error');
        });

        it('should aggregate status correctly', async () => {
            const healthy: HealthChecker = {
                name: 'healthy',
                async check() {
                    return { latency: 5 };
                },
            };

            const unhealthy: HealthChecker = {
                name: 'unhealthy',
                async check() {
                    return { latency: 100, error: 'Failed' };
                },
            };

            manager.registerChecker(healthy);
            manager.registerChecker(unhealthy);

            const report = await manager.checkAll();
            expect(report.status).toBe('unhealthy');
        });

        it('should include uptime in report', async () => {
            const checker: HealthChecker = {
                name: 'test',
                async check() {
                    return { latency: 5 };
                },
            };

            manager.registerChecker(checker);
            const report = await manager.checkAll();

            expect(report.uptime).toBeGreaterThanOrEqual(0);
            expect(typeof report.uptime).toBe('number');
        });

        it('should include timestamp in report', async () => {
            const checker: HealthChecker = {
                name: 'test',
                async check() {
                    return { latency: 5 };
                },
            };

            manager.registerChecker(checker);
            const report = await manager.checkAll();

            expect(report.timestamp).toBeDefined();
            expect(new Date(report.timestamp).getTime()).toBeGreaterThan(0);
        });

        it('should include version in report', async () => {
            const checker: HealthChecker = {
                name: 'test',
                async check() {
                    return { latency: 5 };
                },
            };

            manager.registerChecker(checker);
            const report = await manager.checkAll();

            expect(report.version).toBe('0.1.0');
        });
    });

    describe('getLastReport', () => {
        it('should return cached report', async () => {
            const checker: HealthChecker = {
                name: 'test',
                async check() {
                    return { latency: 5 };
                },
            };

            manager.registerChecker(checker);
            await manager.checkAll();

            const report = manager.getLastReport('0.1.0');
            expect(report.dependencies).toHaveLength(1);
            expect(report.status).toBe('healthy');
        });

        it('should return initial healthy status before first check', () => {
            const checker: HealthChecker = {
                name: 'test',
                async check() {
                    return { latency: 5 };
                },
            };

            manager.registerChecker(checker);
            const report = manager.getLastReport('0.1.0');

            expect(report.status).toBe('healthy');
            expect(report.dependencies[0].status).toBe('healthy');
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

            // Note: This will make a real HTTP request in tests
            // In production, you'd mock this
            const result = await checker.check();
            expect(result.latency).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Status aggregation', () => {
        it('should return healthy when all dependencies are healthy', async () => {
            const checker1: HealthChecker = {
                name: 'service1',
                async check() {
                    return { latency: 5 };
                },
            };

            const checker2: HealthChecker = {
                name: 'service2',
                async check() {
                    return { latency: 10 };
                },
            };

            manager.registerChecker(checker1);
            manager.registerChecker(checker2);

            const report = await manager.checkAll();
            expect(report.status).toBe('healthy');
        });

        it('should return unhealthy when any dependency is unhealthy', async () => {
            const checker1: HealthChecker = {
                name: 'service1',
                async check() {
                    return { latency: 5 };
                },
            };

            const checker2: HealthChecker = {
                name: 'service2',
                async check() {
                    return { latency: 100, error: 'Failed' };
                },
            };

            manager.registerChecker(checker1);
            manager.registerChecker(checker2);

            const report = await manager.checkAll();
            expect(report.status).toBe('unhealthy');
        });
    });
});
