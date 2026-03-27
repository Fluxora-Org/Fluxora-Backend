/**
 * Environment configuration module for Fluxora Backend
 * 
 * Responsibilities:
 * - Load and validate environment variables at startup
 * - Provide typed, immutable configuration object
 * - Fail fast on invalid configuration
 * - Support multiple environments (dev, staging, production)
 * 
 * Trust boundaries:
 * - Public: PORT, API_VERSION
 * - Authenticated: DATABASE_URL, REDIS_URL
 * - Admin-only: JWT_SECRET, HORIZON_SECRET_KEY
 * 
 * Multi-network contract addresses:
 * - STELLAR_NETWORK selects testnet or mainnet
 * - CONTRACT_ADDRESS_STREAMING overrides the default per-network address
 * - Defaults are well-known Fluxora contract addresses per network
 */

/**
 * Known Stellar network identifiers and their default passphrases + contract addresses.
 * Operators may override contract addresses via CONTRACT_ADDRESS_* env vars.
 */
export const STELLAR_NETWORKS = {
    testnet: {
        passphrase: 'Test SDF Network ; September 2015',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        // Placeholder — replace with deployed testnet contract ID
        streamingContractAddress: 'TESTNET_STREAMING_CONTRACT_PLACEHOLDER',
    },
    mainnet: {
        passphrase: 'Public Global Stellar Network ; September 2015',
        horizonUrl: 'https://horizon.stellar.org',
        // Placeholder — replace with deployed mainnet contract ID
        streamingContractAddress: 'MAINNET_STREAMING_CONTRACT_PLACEHOLDER',
    },
} as const;

export type StellarNetwork = keyof typeof STELLAR_NETWORKS;

/**
 * Contract addresses resolved for the active network.
 * All fields are required — missing addresses cause a startup ConfigError.
 */
export interface ContractAddresses {
    /** Soroban contract ID for the streaming contract */
    streaming: string;
}

export interface Config {
    // Server
    port: number;
    nodeEnv: 'development' | 'staging' | 'production';
    apiVersion: string;

    // Database
    databaseUrl: string;
    databasePoolSize: number;
    databaseConnectionTimeout: number;

    // Cache
    redisUrl: string;
    redisEnabled: boolean;

    // Stellar — network-aware
    stellarNetwork: StellarNetwork;
    horizonUrl: string;
    horizonNetworkPassphrase: string;
    contractAddresses: ContractAddresses;

    // Security
    jwtSecret: string;
    jwtExpiresIn: string;

    // Request protection
    maxRequestSizeBytes: number;
    maxJsonDepth: number;
    requestTimeoutMs: number;

    // Observability
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    metricsEnabled: boolean;

    // Feature flags
    enableStreamValidation: boolean;
    enableRateLimit: boolean;
}

/**
 * Validation error for configuration issues
 */
export class ConfigError extends Error {
    constructor(message: string) {
        super(`Configuration Error: ${message}`);
        this.name = 'ConfigError';
    }
}

/**
 * Parse and validate integer environment variable
 */
function parseIntEnv(value: string | undefined, defaultValue: number, min?: number, max?: number): number {
    if (value === undefined) return defaultValue;

    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        throw new ConfigError(`Expected integer, got "${value}"`);
    }

    if (min !== undefined && parsed < min) {
        throw new ConfigError(`Value ${parsed} is below minimum ${min}`);
    }

    if (max !== undefined && parsed > max) {
        throw new ConfigError(`Value ${parsed} exceeds maximum ${max}`);
    }

    return parsed;
}

/**
 * Parse and validate byte size environment variable (supports units: b, kb, mb)
 */
function parseBytesEnv(value: string | undefined, defaultBytes: number): number {
    if (value === undefined) return defaultBytes;

    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
    if (!match) {
        throw new ConfigError(`Invalid byte size format: ${value}. Use format like "10mb", "512kb", or "1024"`);
    }

    const num = parseFloat(match[1]);
    const unit = (match[2] ?? 'b').toLowerCase();

    const multipliers: Record<string, number> = {
        b: 1,
        kb: 1024,
        mb: 1024 * 1024,
        gb: 1024 * 1024 * 1024,
    };

    const bytes = num * (multipliers[unit] ?? 1);
    if (bytes <= 0) {
        throw new ConfigError(`Byte size must be positive: ${value}`);
    }

    return Math.floor(bytes);
}

/**
 * Parse and validate boolean environment variable
 */
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Validate required environment variable
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new ConfigError(`Required environment variable missing: ${name}`);
    }
    return value;
}

/**
 * Validate URL format
 */
function validateUrl(url: string, name: string): string {
    try {
        new URL(url);
        return url;
    } catch {
        throw new ConfigError(`Invalid URL for ${name}: ${url}`);
    }
}

/**
 * Resolve and validate the active Stellar network.
 * STELLAR_NETWORK must be "testnet" or "mainnet"; defaults to "testnet".
 * In production, mainnet is required unless explicitly overridden.
 */
function resolveNetwork(nodeEnv: string): StellarNetwork {
    const raw = process.env.STELLAR_NETWORK ?? (nodeEnv === 'production' ? 'mainnet' : 'testnet');
    if (raw !== 'testnet' && raw !== 'mainnet') {
        throw new ConfigError(`STELLAR_NETWORK must be "testnet" or "mainnet", got "${raw}"`);
    }
    return raw;
}

/**
 * Resolve contract addresses for the active network.
 * Operators may override any address via CONTRACT_ADDRESS_STREAMING.
 * Missing addresses in production cause a startup failure.
 */
function resolveContractAddresses(network: StellarNetwork, isProduction: boolean): ContractAddresses {
    const defaults = STELLAR_NETWORKS[network];

    const streaming = process.env.CONTRACT_ADDRESS_STREAMING ?? defaults.streamingContractAddress;

    // In production, reject placeholder values — operators must supply real addresses
    if (isProduction && streaming.includes('PLACEHOLDER')) {
        throw new ConfigError(
            'CONTRACT_ADDRESS_STREAMING must be set to a real contract address in production. ' +
            'Set the CONTRACT_ADDRESS_STREAMING environment variable.'
        );
    }

    return { streaming };
}

/**
 * Load and validate configuration from environment
 * Throws ConfigError if validation fails
 */
export function loadConfig(): Config {
    const nodeEnv = (process.env.NODE_ENV ?? 'development') as 'development' | 'staging' | 'production';

    // In production, enforce required secrets
    const isProduction = nodeEnv === 'production';

    const databaseUrl = isProduction
        ? validateUrl(requireEnv('DATABASE_URL'), 'DATABASE_URL')
        : validateUrl(process.env.DATABASE_URL ?? 'postgresql://localhost/fluxora', 'DATABASE_URL');

    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

    // Resolve network first — Horizon URL and passphrase derive from it
    const stellarNetwork = resolveNetwork(nodeEnv);
    const networkDefaults = STELLAR_NETWORKS[stellarNetwork];

    const horizonUrl = validateUrl(
        process.env.HORIZON_URL ?? networkDefaults.horizonUrl,
        'HORIZON_URL'
    );

    const horizonNetworkPassphrase =
        process.env.HORIZON_NETWORK_PASSPHRASE ?? networkDefaults.passphrase;

    const contractAddresses = resolveContractAddresses(stellarNetwork, isProduction);

    const jwtSecret = isProduction
        ? requireEnv('JWT_SECRET')
        : process.env.JWT_SECRET ?? 'dev-secret-key-change-in-production';

    if (jwtSecret.length < 32 && isProduction) {
        throw new ConfigError('JWT_SECRET must be at least 32 characters in production');
    }

    const config: Config = {
        port: parseIntEnv(process.env.PORT, 3000, 1, 65535),
        nodeEnv,
        apiVersion: '0.1.0',

        databaseUrl,
        databasePoolSize: parseIntEnv(process.env.DATABASE_POOL_SIZE, 10, 1, 100),
        databaseConnectionTimeout: parseIntEnv(process.env.DATABASE_CONNECTION_TIMEOUT, 5000, 1000, 60000),

        redisUrl: validateUrl(redisUrl, 'REDIS_URL'),
        redisEnabled: parseBoolEnv(process.env.REDIS_ENABLED, true),

        stellarNetwork,
        horizonUrl,
        horizonNetworkPassphrase,
        contractAddresses,

        jwtSecret,
        jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',

        maxRequestSizeBytes: parseBytesEnv(process.env.MAX_REQUEST_SIZE, 1024 * 1024), // 1MB default
        maxJsonDepth: parseIntEnv(process.env.MAX_JSON_DEPTH, 20, 1, 1000),
        requestTimeoutMs: parseIntEnv(process.env.REQUEST_TIMEOUT_MS, 30000, 1000, 300000),

        logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
        metricsEnabled: parseBoolEnv(process.env.METRICS_ENABLED, true),

        enableStreamValidation: parseBoolEnv(process.env.ENABLE_STREAM_VALIDATION, true),
        enableRateLimit: parseBoolEnv(process.env.ENABLE_RATE_LIMIT, !isProduction),
    };

    return config;
}

/**
 * Singleton instance - loaded once at startup
 */
let configInstance: Config | null = null;

/**
 * Get the loaded configuration
 * Must call initialize() first
 */
export function getConfig(): Config {
    if (!configInstance) {
        throw new ConfigError('Configuration not initialized. Call initialize() first.');
    }
    return configInstance;
}

/**
 * Initialize configuration at application startup
 * Throws ConfigError if validation fails
 */
export function initializeConfig(): Config {
    if (configInstance) {
        return configInstance;
    }

    configInstance = loadConfig();
    return configInstance;
}

/**
 * Reset configuration (for testing)
 */
export function resetConfig(): void {
    configInstance = null;
}
