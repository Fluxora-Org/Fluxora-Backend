/**
 * Composed environment schema.
 *
 * Assembles the per-subsystem fragments in `src/config/env-schema/` into the
 * single `EnvSchema` object previously defined (monolithically) in `env.ts`.
 * The composition is a plain spread of zod object-shapes, so the resulting
 * schema parses, defaults, and rejects exactly the same inputs as before —
 * see `tests/config/env.schema-split.test.ts` for the equivalence checks.
 *
 * Cross-field invariants (Stellar passphrase/pinned addresses, API_KEY_PEPPER,
 * production LOG_LEVEL/CORS/PGCRYPTO_KEY) deliberately live here in
 * `superRefine`, not in the fragments.
 */
import { z } from 'zod';
import { type StellarNetwork } from '../stellar.js';
import {
  getPinnedAddressNetwork,
  STELLAR_NETWORK_PASSPHRASES,
  type PinnedStellarAddressKind,
} from '../stellarContracts.js';
import { coreEnvSchema } from './core.js';
import { databaseEnvSchema } from './database.js';
import { redisEnvSchema } from './redis.js';
import { stellarEnvSchema } from './stellar.js';
import { authEnvSchema } from './auth.js';
import { httpEnvSchema } from './http.js';
import { webhooksEnvSchema } from './webhooks.js';
import { serverEnvSchema } from './server.js';
import { indexerEnvSchema } from './indexer.js';
import { rateLimitEnvSchema } from './rateLimit.js';
import { infrastructureEnvSchema } from './infrastructure.js';
import type { NodeEnv } from './types.js';

export type { NodeEnv, LogLevel } from './types.js';

function resolvedStellarNetwork(env: {
  NODE_ENV: NodeEnv;
  STELLAR_NETWORK?: StellarNetwork;
}): StellarNetwork {
  return env.STELLAR_NETWORK ?? (env.NODE_ENV === 'production' ? 'mainnet' : 'testnet');
}

function validatePinnedAddress(
  ctx: z.RefinementCtx,
  network: StellarNetwork,
  kind: PinnedStellarAddressKind,
  path: 'STELLAR_CONTRACT_ADDRESS' | 'STELLAR_TOKEN_ADDRESS' | 'CONTRACT_ADDRESS_STREAMING' | (string & {}),
  address: string
): void {
  if (network === 'local') return;

  const pinnedNetwork = getPinnedAddressNetwork(kind, address);

  if (pinnedNetwork === network) return;

  ctx.addIssue({
    code: 'custom',
    path: [path],
    message:
      pinnedNetwork === null
        ? `${path} is not in the known-good ${network} ${kind} address allowlist`
        : `${path} is pinned for ${pinnedNetwork} but STELLAR_NETWORK resolves to ${network}`,
  });
}

/**
 * The composed object shape (all fragments merged) as a plain record of zod
 * schemas keyed by env-var name. Exported so tooling (the generated env
 * reference, tests) can enumerate every variable without unwrapping the
 * refined schema.
 */
export const EnvSchemaShape = {
  ...coreEnvSchema,
  ...databaseEnvSchema,
  ...redisEnvSchema,
  ...stellarEnvSchema,
  ...authEnvSchema,
  ...httpEnvSchema,
  ...webhooksEnvSchema,
  ...serverEnvSchema,
  ...indexerEnvSchema,
  ...rateLimitEnvSchema,
  ...infrastructureEnvSchema,
} as const;

export const EnvSchema = z
  .object(EnvSchemaShape)
  .passthrough()
  .superRefine((env, ctx) => {
    const stellarNetwork = resolvedStellarNetwork(env);
    const expectedPassphrase = STELLAR_NETWORK_PASSPHRASES[stellarNetwork];

    if (
      env.HORIZON_NETWORK_PASSPHRASE !== undefined &&
      env.HORIZON_NETWORK_PASSPHRASE !== expectedPassphrase
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['HORIZON_NETWORK_PASSPHRASE'],
        message: `HORIZON_NETWORK_PASSPHRASE must match ${stellarNetwork} passphrase`,
      });
    }

    validatePinnedAddress(
      ctx,
      stellarNetwork,
      'contract',
      'STELLAR_CONTRACT_ADDRESS',
      env.STELLAR_CONTRACT_ADDRESS
    );
    validatePinnedAddress(
      ctx,
      stellarNetwork,
      'token',
      'STELLAR_TOKEN_ADDRESS',
      env.STELLAR_TOKEN_ADDRESS
    );
    if (env.CONTRACT_ADDRESS_STREAMING) {
      validatePinnedAddress(
        ctx,
        stellarNetwork,
        'streaming',
        'CONTRACT_ADDRESS_STREAMING',
        env.CONTRACT_ADDRESS_STREAMING
      );
    }

    const hasApiKeys = env.API_KEYS !== undefined && env.API_KEYS.trim().length > 0;
    if (hasApiKeys && env.API_KEY_PEPPER === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_KEY_PEPPER'],
        message: 'API_KEY_PEPPER is required when API_KEYS is configured',
      });
    }

    if (env.NODE_ENV === 'production') {
      if (env.LOG_LEVEL === 'debug') {
        ctx.addIssue({
          code: 'custom',
          path: ['LOG_LEVEL'],
          message: 'LOG_LEVEL must not be "debug" in production',
        });
      }

      if (env.CORS_ALLOWED_ORIGINS !== undefined && env.CORS_ALLOWED_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS must not contain a wildcard "*" origin in production',
        });
      }

      if (env.PGCRYPTO_KEY === undefined || env.PGCRYPTO_KEY.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['PGCRYPTO_KEY'],
          message: 'PGCRYPTO_KEY is required in production (minimum 32 characters)',
        });
      }
    }
  });

export type ParsedEnv = z.infer<typeof EnvSchema>;
