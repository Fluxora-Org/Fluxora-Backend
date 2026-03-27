import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadConfig, resetConfig, ConfigError, STELLAR_NETWORKS } from './env';

describe('Environment Configuration', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        resetConfig();
    });

    afterEach(() => {
        process.env = originalEnv;
        resetConfig();
    });

    describe('loadConfig', () => {
        it('should load default configuration in development', () => {
            process.env.NODE_ENV = 'development';
            const config = loadConfig();

            expect(config.nodeEnv).toBe('development');
            expect(config.port).toBe(3000);
            expect(config.logLevel).toBe('info');
        });

        it('should load request protection defaults', () => {
            process.env.NODE_ENV = 'development';
            const config = loadConfig();

            expect(config.maxRequestSizeBytes).toBe(1024 * 1024); // 1MB
            expect(config.maxJsonDepth).toBe(20);
            expect(config.requestTimeoutMs).toBe(30000);
        });

        it('should parse MAX_REQUEST_SIZE with byte units', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_REQUEST_SIZE = '5mb';
            const config = loadConfig();

            expect(config.maxRequestSizeBytes).toBe(5 * 1024 * 1024);
        });

        it('should parse MAX_REQUEST_SIZE with kb units', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_REQUEST_SIZE = '512kb';
            const config = loadConfig();

            expect(config.maxRequestSizeBytes).toBe(512 * 1024);
        });

        it('should parse MAX_REQUEST_SIZE as plain bytes', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_REQUEST_SIZE = '1024';
            const config = loadConfig();

            expect(config.maxRequestSizeBytes).toBe(1024);
        });

        it('should reject invalid MAX_REQUEST_SIZE format', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_REQUEST_SIZE = 'invalid';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should reject negative MAX_REQUEST_SIZE', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_REQUEST_SIZE = '-100';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should parse MAX_JSON_DEPTH', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_JSON_DEPTH = '50';
            const config = loadConfig();

            expect(config.maxJsonDepth).toBe(50);
        });

        it('should enforce MAX_JSON_DEPTH minimum', () => {
            process.env.NODE_ENV = 'development';
            process.env.MAX_JSON_DEPTH = '0';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should parse REQUEST_TIMEOUT_MS', () => {
            process.env.NODE_ENV = 'development';
            process.env.REQUEST_TIMEOUT_MS = '60000';
            const config = loadConfig();

            expect(config.requestTimeoutMs).toBe(60000);
        });

        it('should enforce REQUEST_TIMEOUT_MS minimum', () => {
            process.env.NODE_ENV = 'development';
            process.env.REQUEST_TIMEOUT_MS = '500';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should enforce REQUEST_TIMEOUT_MS maximum', () => {
            process.env.NODE_ENV = 'development';
            process.env.REQUEST_TIMEOUT_MS = '400000';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should require DATABASE_URL in production', () => {
            process.env.NODE_ENV = 'production';
            delete process.env.DATABASE_URL;

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should require JWT_SECRET in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            delete process.env.JWT_SECRET;

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should enforce JWT_SECRET minimum length in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            process.env.JWT_SECRET = 'short';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should validate port range', () => {
            process.env.NODE_ENV = 'development';
            process.env.PORT = '99999';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should validate database pool size range', () => {
            process.env.NODE_ENV = 'development';
            process.env.DATABASE_POOL_SIZE = '200';

            expect(() => loadConfig()).toThrow(ConfigError);
        });
    });

    // -------------------------------------------------------------------------
    // Issue #35 — Multi-network contract addresses
    // -------------------------------------------------------------------------
    describe('multi-network contract addresses', () => {
        it('should default to testnet in development', () => {
            process.env.NODE_ENV = 'development';
            const config = loadConfig();

            expect(config.stellarNetwork).toBe('testnet');
            expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORKS.testnet.passphrase);
            expect(config.horizonUrl).toBe(STELLAR_NETWORKS.testnet.horizonUrl);
        });

        it('should default to mainnet in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            process.env.JWT_SECRET = 'a-very-long-secret-key-for-production-use';
            process.env.CONTRACT_ADDRESS_STREAMING = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZOR';

            const config = loadConfig();

            expect(config.stellarNetwork).toBe('mainnet');
            expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORKS.mainnet.passphrase);
        });

        it('should allow explicit STELLAR_NETWORK=testnet override', () => {
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_NETWORK = 'testnet';
            const config = loadConfig();

            expect(config.stellarNetwork).toBe('testnet');
            expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORKS.testnet.passphrase);
        });

        it('should allow explicit STELLAR_NETWORK=mainnet in development', () => {
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_NETWORK = 'mainnet';
            const config = loadConfig();

            expect(config.stellarNetwork).toBe('mainnet');
            expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORKS.mainnet.passphrase);
        });

        it('should reject unknown STELLAR_NETWORK value', () => {
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_NETWORK = 'devnet';

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should use default testnet contract address when not overridden', () => {
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_NETWORK = 'testnet';
            const config = loadConfig();

            expect(config.contractAddresses.streaming).toBe(
                STELLAR_NETWORKS.testnet.streamingContractAddress
            );
        });

        it('should use default mainnet contract address when not overridden', () => {
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_NETWORK = 'mainnet';
            const config = loadConfig();

            expect(config.contractAddresses.streaming).toBe(
                STELLAR_NETWORKS.mainnet.streamingContractAddress
            );
        });

        it('should allow CONTRACT_ADDRESS_STREAMING override', () => {
            process.env.NODE_ENV = 'development';
            const customAddress = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZOR';
            process.env.CONTRACT_ADDRESS_STREAMING = customAddress;
            const config = loadConfig();

            expect(config.contractAddresses.streaming).toBe(customAddress);
        });

        it('should reject placeholder contract address in production', () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/fluxora';
            process.env.JWT_SECRET = 'a-very-long-secret-key-for-production-use';
            // Do NOT set CONTRACT_ADDRESS_STREAMING — placeholder should be rejected

            expect(() => loadConfig()).toThrow(ConfigError);
        });

        it('should allow HORIZON_URL override independent of network', () => {
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.HORIZON_URL = 'https://custom-horizon.example.com';
            const config = loadConfig();

            expect(config.horizonUrl).toBe('https://custom-horizon.example.com');
        });

        it('should allow HORIZON_NETWORK_PASSPHRASE override', () => {
            process.env.NODE_ENV = 'development';
            process.env.HORIZON_NETWORK_PASSPHRASE = 'Custom Network ; 2024';
            const config = loadConfig();

            expect(config.horizonNetworkPassphrase).toBe('Custom Network ; 2024');
        });
    });
});
