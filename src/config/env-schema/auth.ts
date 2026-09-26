/**
 * Authentication, secrets, and OIDC environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect. The API_KEY_PEPPER ⇄ API_KEYS
 * co-presence invariant lives in the composed schema's `superRefine`.
 */
import { z } from 'zod';
import { optionalString, optionalUrlString } from './parsers.js';

function secretWithMin(name: string, message: string) {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32, message).optional()
  );
}

export const authEnvSchema = {
  /** Signs JWTs. Required, minimum 32 characters. Values never appear in error messages. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Previous signing key, still accepted during key rotation. Min 32 chars. */
  JWT_SECRET_PREVIOUS: secretWithMin(
    'JWT_SECRET_PREVIOUS',
    'JWT_SECRET_PREVIOUS must be at least 32 characters'
  ),
  /**
   * pgcrypto column-encryption key for PII columns. Required in production
   * (minimum 32 characters); optional otherwise.
   */
  PGCRYPTO_KEY: secretWithMin('PGCRYPTO_KEY', 'PGCRYPTO_KEY must be at least 32 characters'),
  /** Previous pgcrypto key, still used to read rows written before rotation. Min 32 chars. */
  PGCRYPTO_KEY_PREVIOUS: secretWithMin(
    'PGCRYPTO_KEY_PREVIOUS',
    'PGCRYPTO_KEY_PREVIOUS must be at least 32 characters'
  ),
  /** JWT lifetime string accepted by jsonwebtoken, e.g. '24h'. @default '24h' */
  JWT_EXPIRES_IN: z.string().min(1, 'JWT_EXPIRES_IN cannot be empty').default('24h'),
  /**
   * Comma-separated list of valid API keys. When set, API_KEY_PEPPER becomes
   * required (superRefine invariant).
   */
  API_KEYS: z.string().optional(),
  /**
   * Server-side pepper mixed into every API-key hash. Keeping it out of the
   * database means a leaked `api_keys` table cannot be brute-forced offline.
   * Optional so non-API-key deployments still boot; required at runtime by the
   * hashing helpers, which fail closed when it is absent.
   */
  API_KEY_PEPPER: secretWithMin('API_KEY_PEPPER', 'API_KEY_PEPPER must be at least 32 characters'),
  /** Previous API-key pepper, accepted while keys are re-hashed during rotation. */
  API_KEY_PEPPER_PREVIOUS: secretWithMin(
    'API_KEY_PEPPER_PREVIOUS',
    'API_KEY_PEPPER_PREVIOUS must be at least 32 characters'
  ),
  /** Shared token indexer workers use to authenticate to the API. Required, min 32 chars. */
  INDEXER_WORKER_TOKEN: z
    .string()
    .min(32, 'INDEXER_WORKER_TOKEN must be at least 32 characters'),
  /**
   * Bootstrap admin API key for administrative endpoints.
   * @default unset (admin key auth disabled)
   */
  ADMIN_API_KEY: optionalString('ADMIN_API_KEY'),

  /** OIDC issuer base URL, e.g. https://accounts.example.com. JWKS is fetched
   *  from `${OIDC_ISSUER_URL}/.well-known/jwks.json`. Unset disables OIDC login. */
  OIDC_ISSUER_URL: optionalUrlString('OIDC_ISSUER_URL'),
  /** Expected `aud` (client_id) claim on OIDC ID tokens. */
  OIDC_AUDIENCE: optionalString('OIDC_AUDIENCE'),
};
