/**
 * Configuration Module Composer
 * 
 * Precedence Documentation:
 * When overlapping settings are defined across multiple configuration modules,
 * the modules are merged in the explicit order defined in `COMPOSITION_ORDER`.
 * Modules listed LATER in the array take precedence over those listed EARLIER.
 * 
 * For example, if module A sets `{ port: 3000 }` and module B sets `{ port: 8080 }`,
 * and the order is `[A, B]`, the effective configuration will have `{ port: 8080 }`.
 */

export interface ConfigModule {
  [key: string]: any;
}

// 10 Configuration Modules as requested
export const baseConfig = { serverUrl: 'http://localhost', port: 3000, setting1: 'base' };
export const databaseConfig = { dbUrl: 'postgres://localhost:5432' };
export const cacheConfig = { redisUrl: 'redis://localhost:6379' };
export const featureFlagsConfig = { newFeature: false, overlappingSetting: 'flag' };
export const loggingConfig = { logLevel: 'info' };
export const rateLimitConfig = { rateLimit: 100 };
export const securityConfig = { cors: true };
export const metricsConfig = { enableMetrics: true };
export const externalServiceConfig = { serviceUrl: 'http://external' };
export const envOverrideConfig = { port: 8080, overlappingSetting: 'envOverride' }; // Overrides port and overlappingSetting

/**
 * The composition order is explicitly declared here.
 * The effective configuration does NOT depend on import order.
 * Precedence: Later modules override earlier ones.
 */
export const COMPOSITION_ORDER: ConfigModule[] = [
  baseConfig,
  databaseConfig,
  cacheConfig,
  featureFlagsConfig,
  loggingConfig,
  rateLimitConfig,
  securityConfig,
  metricsConfig,
  externalServiceConfig,
  envOverrideConfig // Highest precedence
];

export function composeConfiguration(modules: ConfigModule[] = COMPOSITION_ORDER): Record<string, any> {
  return modules.reduce((acc, currentModule) => {
    return { ...acc, ...currentModule };
  }, {});
}

export const config = composeConfiguration();
