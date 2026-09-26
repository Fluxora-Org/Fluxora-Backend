/**
 * Per-subsystem environment-schema fragments.
 *
 * Each fragment is a plain object of zod schemas keyed by env-var name;
 * `src/config/env.ts` spreads them into one `z.object()` so the composed
 * schema is exactly equivalent to the original single-file definition.
 *
 * Guidelines for contributors:
 * - Every field MUST carry a JSDoc comment with its purpose and default.
 * - Never add cross-field invariants here; they belong in the composed
 *   schema's `superRefine` (see `src/config/env.ts`).
 */
export { SECRET_ENV_NAMES } from './parsers.js';
export type { NodeEnv, LogLevel } from './types.js';

export { coreEnvSchema } from './core.js';
export { databaseEnvSchema } from './database.js';
export { redisEnvSchema } from './redis.js';
export { stellarEnvSchema } from './stellar.js';
export { authEnvSchema } from './auth.js';
export { httpEnvSchema } from './http.js';
export { webhooksEnvSchema } from './webhooks.js';
export { serverEnvSchema } from './server.js';
export { indexerEnvSchema } from './indexer.js';
export { rateLimitEnvSchema } from './rateLimit.js';
export { infrastructureEnvSchema } from './infrastructure.js';
