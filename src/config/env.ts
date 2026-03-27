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
 */

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

    // Stellar
    horizonUrl: string;
    horizonNetworkPassphrase: string;

    // Security
    jwtSecret: string;
    jwtExpiresIn: string;

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
    const horizonUrl = validateUrl(
        process.env.HORIZON_URL ?? 'https://horizon.stellar.org',
        'HORIZON_URL'
    );

    const jwtSecret = isProduction
        ? requireEnv('JWT_SECRET')
        : process.env.JWT_SECRET ?? 'dev-secret-key-change-in-production';

    if (jwtSecret.length < 32 && isProduction) {
        throw new ConfigError('JWT_SECRET must be at least 32 characters in production');
    }

    const horizonNetworkPassphrase = process.env.HORIZON_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';

    const config: Config = {
        port: parseIntEnv(process.env.PORT, 3000, 1, 65535),
        nodeEnv,
        apiVersion: '0.1.0',

        databaseUrl,
        databasePoolSize: parseIntEnv(process.env.DATABASE_POOL_SIZE, 10, 1, 100),
        databaseConnectionTimeout: parseIntEnv(process.env.DATABASE_CONNECTION_TIMEOUT, 5000, 1000, 60000),

        redisUrl: validateUrl(redisUrl, 'REDIS_URL'),
        redisEnabled: parseBoolEnv(process.env.REDIS_ENABLED, true),

        horizonUrl,
        horizonNetworkPassphrase,

        jwtSecret,
        jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',

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
