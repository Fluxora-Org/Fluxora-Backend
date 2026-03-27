import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    loadConfig,
    initializeConfig,
    getConfig,
    resetConfig,
    ConfigError,
} from './env.js';

describe('Environment Configuration', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
        process.env.NODE_ENV = 'development';
    });

    afterEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
    });

    describe('loadConfig', () => {
        it('should load default configuration in development', () => {
            process.env.NODE_ENV = 'development';
            const config = loadConfig();

            assert.strictEqual(config.port, 3000);
            assert.strictEqual(config.nodeEnv, 'development');
            assert.strictEqual(config.logLevel, 'info');
            assert.strictEqual(config.databasePoolSize, 10);
        });

        it('should parse PORT from environment', () => {
            process.env.PORT = '8080';
            const config = loadConfig();
            assert.strictEqual(config.port, 8080);
        });

        it('should reject invalid PORT', () => {
            process.env.PORT = 'invalid';
            assert.throws(() => loadConfig(), ConfigError);
        });

        it('should parse DATABASE_POOL_SIZE', () => {
            process.env.DATABASE_POOL_SIZE = '20';
            const config = loadConfig();
            assert.strictEqual(config.databasePoolSize, 20);
        });

        it('should parse LOG_LEVEL', () => {
            process.env.LOG_LEVEL = 'debug';
            const config = loadConfig();
            assert.strictEqual(config.logLevel, 'debug');
        });

        it('should parse boolean environment variables', () => {
            process.env.REDIS_ENABLED = 'false';
            process.env.METRICS_ENABLED = 'true';
            const config = loadConfig();

            assert.strictEqual(config.redisEnabled, false);
            assert.strictEqual(config.metricsEnabled, true);
        });

        it('should validate DATABASE_URL format', () => {
            process.env.DATABASE_URL = 'not-a-url';
            assert.throws(() => loadConfig(), ConfigError);
        });

        it('should require DATABASE_URL in production', () => {
            process.env.NODE_ENV = 'production';
            delete process.env.DATABASE_URL;
            assert.throws(() => loadConfig(), ConfigError);
        });

        it('should require JWT_SECRET in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            delete process.env.JWT_SECRET;
            assert.throws(() => loadConfig(), ConfigError);
        });
    });

    describe('initializeConfig', () => {
        it('should initialize config once', () => {
            const config1 = initializeConfig();
            const config2 = initializeConfig();

            assert.strictEqual(config1, config2);
        });
    });

    describe('getConfig', () => {
        it('should return initialized config', () => {
            initializeConfig();
            const config = getConfig();

            assert.ok(config);
            assert.ok(config.port);
        });

        it('should throw if not initialized', () => {
            resetConfig();
            assert.throws(() => getConfig(), ConfigError);
        });
    });
});
