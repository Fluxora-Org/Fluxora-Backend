/**
 * Core (process/runtime) environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { z } from 'zod';
import { booleanEnv, integerEnv } from './parsers.js';

export const coreEnvSchema = {
  /**
   * Runtime deployment target. Drives production-only invariants (debug-log
   * ban, wildcard-CORS ban, PGCRYPTO_KEY requirement) and the default Stellar
   * network.
   * @default 'development'
   */
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  /** HTTP listen port for the Express server. Range 1–65535. @default 3000 */
  PORT: integerEnv('PORT', 1, 65535).default(3000),

  /**
   * Master shutdown switch: when truthy the process drains and exits.
   * Used by orchestrators to quiesce the service.
   * @default unset (service keeps running)
   */
  FLUXORA_SHUTDOWN: booleanEnv().optional(),
};
