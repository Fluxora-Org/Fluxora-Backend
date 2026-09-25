/**
 * Startup configuration validation (issue #1437).
 *
 * Every configuration module under `src/config/` exposes a pure
 * `validate*Config()` function that returns a list of human-readable issues,
 * each naming the invalid setting. This aggregator runs them all during
 * application bootstrap (both `createApp()` in `src/app.ts` and the startup
 * sequence in `src/index.ts`) and throws the existing `ConfigError` from
 * `src/config/env.ts` when anything is invalid, so a bad deployment fails
 * immediately at startup instead of on first use during request handling.
 *
 * The validators are deliberately plain functions returning `string[]`
 * (not a new validation framework): they reuse each module's own semantics
 * and the project's existing `ConfigError` reporting style.
 */

import { ConfigError, loadConfig } from './env.js';
import { validateStellarConfig } from './stellar.js';
import { validateStellarContractsConfig } from './stellarContracts.js';
import { validateRateLimitsConfig } from './rateLimits.js';
import { validateHealthConfig } from './health.js';
import { validateDeploymentConfig } from './deployment.js';
import { validateDeprecationsConfig } from './deprecations.js';

export interface ValidateStartupConfigOptions {
  /**
   * Environment used for env-driven validators (defaults to `process.env`).
   * Mirrors `AppOptions.env` so apps built with an explicit env object are
   * validated against exactly what their middleware will consume.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Validate every configuration module.
 *
 * Throws `ConfigError` whose message lists one bullet per invalid setting
 * (e.g. `- RATE_LIMIT_IP_MAX must be an integer >= 1 (got "abc")`).
 *
 * Note: the env schema in `src/config/env.ts` is additionally enforced at
 * module load and via `loadConfig()` here, so schema-level env problems also
 * surface through this call as `EnvironmentError` (a `ConfigError` subclass).
 */
export function validateStartupConfig(
  options: ValidateStartupConfigOptions = {},
): void {
  const issues: string[] = [
    ...validateStellarConfig(),
    ...validateStellarContractsConfig(),
    ...validateRateLimitsConfig(options.env ?? process.env),
    ...validateDeprecationsConfig(),
  ];

  // The full env schema also feeds health and deployment knobs.
  const config = loadConfig();
  issues.push(...validateHealthConfig(config));
  issues.push(...validateDeploymentConfig(config));

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
}
