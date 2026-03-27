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

    // Request limits
    /** Maximum request body size in bytes (default 256 KiB). */
    payloadLimitBytes: number;
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

    // JWT_SECRET must always be explicitly set — no hardcoded fallback.
    // In development a short/weak value is tolerated but warned about.
    // In production the variable is required and must be ≥32 chars.
    const jwtSecret = requireEnv('JWT_SECRET');

    if (jwtSecret.length < 32) {
        if (isProduction) {
            throw new ConfigError('JWT_SECRET must be at least 32 characters in production');
        }
        // Warn in non-production so developers notice without hard-failing CI
        console.warn('[fluxora] WARNING: JWT_SECRET is shorter than 32 characters — use a strong secret in production');
    }

    // Reject the placeholder value from .env.example in all environments
    if (jwtSecret.startsWith('CHANGE_ME')) {
        throw new ConfigError('JWT_SECRET is still set to the placeholder value — replace it with a real secret');
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

        payloadLimitBytes: parseIntEnv(process.env.PAYLOAD_LIMIT_BYTES, 256 * 1024, 1024, 10 * 1024 * 1024),
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
