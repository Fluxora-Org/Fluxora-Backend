import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
    loadConfig,
    initializeConfig,
    getConfig,
    resetConfig,
    ConfigError,
    Config,
} from './env.js';

describe('Environment Configuration', () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        savedEnv = { ...process.env };
        resetConfig();
        process.env['NODE_ENV'] = 'development';
        // Provide a valid JWT_SECRET by default so tests that don't care about it pass
        process.env['JWT_SECRET'] = 'dev-secret-at-least-32-chars-long!!';
        // Clear test-sensitive vars so defaults apply
        delete process.env['PORT'];
        delete process.env['DATABASE_URL'];
        delete process.env['REDIS_URL'];
        delete process.env['HORIZON_URL'];
        delete process.env['DATABASE_POOL_SIZE'];
        delete process.env['DATABASE_CONNECTION_TIMEOUT'];
        delete process.env['LOG_LEVEL'];
        delete process.env['REDIS_ENABLED'];
        delete process.env['METRICS_ENABLED'];
        delete process.env['HORIZON_NETWORK_PASSPHRASE'];
    });

    afterEach(() => {
        process.env = savedEnv;
        resetConfig();
    });

    describe('loadConfig', () => {
        it('should load default configuration in development', () => {
            process.env.NODE_ENV = 'development';
            const config = loadConfig();

            expect(config.port).toBe(3000);
            expect(config.nodeEnv).toBe('development');
            expect(config.logLevel).toBe('info');
            expect(config.databasePoolSize).toBe(10);
        });

        it('should parse PORT from environment', () => {
            process.env.PORT = '8080';
            const config = loadConfig();
            expect(config.port).toBe(8080);
        });

        it('should reject invalid PORT', () => {
            process.env.PORT = 'invalid';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should reject PORT outside valid range', () => {
            process.env.PORT = '99999';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should parse DATABASE_POOL_SIZE', () => {
            process.env.DATABASE_POOL_SIZE = '20';
            const config = loadConfig();
            expect(config.databasePoolSize).toBe(20);
        });

        it('should reject DATABASE_POOL_SIZE below minimum', () => {
            process.env.DATABASE_POOL_SIZE = '0';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should parse LOG_LEVEL', () => {
            process.env.LOG_LEVEL = 'debug';
            const config = loadConfig();
            expect(config.logLevel).toBe('debug');
        });

        it('should parse boolean environment variables', () => {
            process.env.REDIS_ENABLED = 'false';
            process.env.METRICS_ENABLED = 'true';
            const config = loadConfig();

            expect(config.redisEnabled).toBe(false);
            expect(config.metricsEnabled).toBe(true);
        });

        it('should validate DATABASE_URL format', () => {
            process.env.DATABASE_URL = 'not-a-url';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should validate REDIS_URL format', () => {
            process.env['REDIS_URL'] = 'not a url at all :::';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should validate HORIZON_URL format', () => {
            process.env.HORIZON_URL = 'not-a-url';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should require DATABASE_URL in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.JWT_SECRET = 'a'.repeat(32);
            delete process.env.DATABASE_URL;
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should require JWT_SECRET in all environments', () => {
            delete process.env.JWT_SECRET;
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should require JWT_SECRET in production', () => {
            process.env.NODE_ENV = 'production';
            delete process.env.JWT_SECRET;
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should enforce JWT_SECRET minimum length in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            process.env.JWT_SECRET = 'short';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should reject placeholder JWT_SECRET value', () => {
            process.env.JWT_SECRET = 'CHANGE_ME_generate_a_real_secret_before_deploying';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should reject placeholder JWT_SECRET in production too', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            process.env.JWT_SECRET = 'CHANGE_ME_anything';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should allow short JWT_SECRET in development with a warning', () => {
            process.env.NODE_ENV = 'development';
            process.env.JWT_SECRET = 'short-but-set';
            const config = loadConfig();
            expect(config.jwtSecret).toBe('short-but-set');
        });

        it('should parse CONNECTION_TIMEOUT', () => {
            process.env.DATABASE_CONNECTION_TIMEOUT = '10000';
            const config = loadConfig();
            expect(config.databaseConnectionTimeout).toBe(10000);
        });

        it('should reject CONNECTION_TIMEOUT below minimum', () => {
            process.env.DATABASE_CONNECTION_TIMEOUT = '500';
            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should use default HORIZON_NETWORK_PASSPHRASE', () => {
            const config = loadConfig();
            expect(config.horizonNetworkPassphrase).toBe('Test SDF Network ; September 2015');
        });

        it('should parse custom HORIZON_NETWORK_PASSPHRASE', () => {
            process.env.HORIZON_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
            const config = loadConfig();
            expect(config.horizonNetworkPassphrase).toBe('Public Global Stellar Network ; September 2015');
        });

        it('should parse PAYLOAD_LIMIT_BYTES', () => {
            process.env['PAYLOAD_LIMIT_BYTES'] = '65536';
            const config = loadConfig();
            expect(config.payloadLimitBytes).toBe(65536);
        });

        it('should default PAYLOAD_LIMIT_BYTES to 256 KiB', () => {
            delete process.env['PAYLOAD_LIMIT_BYTES'];
            const config = loadConfig();
            expect(config.payloadLimitBytes).toBe(256 * 1024);
        });
    });

    describe('initializeConfig', () => {
        it('should initialize config once', () => {
            const config1 = initializeConfig();
            const config2 = initializeConfig();

            expect(config1).toBe(config2);
        });

        it('should throw ConfigError on invalid configuration', () => {
            process.env.PORT = 'invalid';
            expect(() => initializeConfig()).toThrow(ConfigError);
        });
    });

    describe('getConfig', () => {
        it('should return initialized config', () => {
            initializeConfig();
            const config = getConfig();

            expect(config).toBeDefined();
            expect(config.port).toBeDefined();
        });

        it('should throw if not initialized', () => {
            resetConfig();
            expect(() => getConfig()).toThrow(ConfigError);
        });
    });

    describe('Config interface', () => {
        it('should have all required properties', () => {
            const config = loadConfig();

            expect(config).toHaveProperty('port');
            expect(config).toHaveProperty('nodeEnv');
            expect(config).toHaveProperty('apiVersion');
            expect(config).toHaveProperty('databaseUrl');
            expect(config).toHaveProperty('databasePoolSize');
            expect(config).toHaveProperty('databaseConnectionTimeout');
            expect(config).toHaveProperty('redisUrl');
            expect(config).toHaveProperty('redisEnabled');
            expect(config).toHaveProperty('horizonUrl');
            expect(config).toHaveProperty('horizonNetworkPassphrase');
            expect(config).toHaveProperty('jwtSecret');
            expect(config).toHaveProperty('jwtExpiresIn');
            expect(config).toHaveProperty('logLevel');
            expect(config).toHaveProperty('metricsEnabled');
            expect(config).toHaveProperty('enableStreamValidation');
            expect(config).toHaveProperty('enableRateLimit');
            expect(config).toHaveProperty('payloadLimitBytes');
        });
    });

    describe('Production safety', () => {
        it('should enforce strict validation in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            process.env.JWT_SECRET = 'a'.repeat(32);

            const config = loadConfig();
            expect(config.nodeEnv).toBe('production');
        });

        it('should allow lenient defaults in development', () => {
            process.env.NODE_ENV = 'development';
            const config = loadConfig();

            expect(config.jwtSecret).toBeDefined();
            expect(config.databaseUrl).toBeDefined();
        });
    });
});

