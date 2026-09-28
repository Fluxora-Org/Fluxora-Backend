/**
 * Canonical logger re-export and log-level policy.
 *
 * All code should import the logger from `src/lib/logger.ts`; this shim keeps
 * legacy imports working and adds the pieces that bind the logger to the
 * validated environment configuration:
 *
 *   - `LOG_LEVEL` is validated by the config schema and applied at startup.
 *   - `error` output can never be disabled by configuration.
 *   - the effective level is recorded once at boot so operators can always
 *     tell which threshold a deployment is running with.
 */
import { isLogLevel, setLogLevel, writeAlways, type LogLevel } from '../lib/logger.js';

export * from '../lib/logger.js';

/** The subset of the validated configuration that controls logging. */
export interface LogLevelConfig {
  logLevel: LogLevel;
  nodeEnv: string;
}

/**
 * Apply the schema-validated `LOG_LEVEL` to the active logger.
 *
 * Unknown values fall back to `info` rather than silently disabling logging.
 */
export function applyLogLevelFromConfig(config: LogLevelConfig): LogLevel {
  return setLogLevel(isLogLevel(config.logLevel) ? config.logLevel : 'info');
}

/**
 * Apply the configured level and record it.
 *
 * The record is emitted unconditionally, so the effective level is always
 * visible at startup even when the configured level would otherwise suppress
 * `info` records.
 */
export function logActiveLogLevel(config: LogLevelConfig): LogLevel {
  const active = applyLogLevelFromConfig(config);
  writeAlways('info', 'logger:level', { logLevel: active, nodeEnv: config.nodeEnv });
  return active;
}
