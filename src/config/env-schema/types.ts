/**
 * Cross-fragment types for the split environment schema.
 *
 * `NodeEnv`/`LogLevel` were previously defined inline in `env.ts`; they are
 * re-homed here so both the fragments and the composed module can import them
 * without cycles.
 */

/** Runtime deployment target (`NODE_ENV`). */
export type NodeEnv = 'development' | 'staging' | 'production' | 'test';

/** Application log verbosity (`LOG_LEVEL`). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
