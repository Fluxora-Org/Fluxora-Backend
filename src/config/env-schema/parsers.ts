/**
 * Shared zod helpers for the per-subsystem environment-schema modules.
 *
 * These are extracted verbatim from the original single-file `env.ts` schema;
 * their behavior is intentionally unchanged. See `src/config/env-schema/` for
 * the per-subsystem fragments and `env.ts` for the composition.
 */
import { z, type ZodBoolean, type ZodOptional, type ZodPipe, type ZodPreprocess, type ZodString } from 'zod';
import { isValidStellarContractAddress } from '../stellarContracts.js';

/**
 * Names of environment variables whose values must never appear in validation
 * error messages. `issueMessage()` (env-config.ts) redacts quoted strings from
 * issues whose first path segment appears in this set.
 */
export const SECRET_ENV_NAMES = new Set([
  'JWT_SECRET',
  'JWT_SECRET_PREVIOUS',
  'INDEXER_WORKER_TOKEN',
  'WEBHOOK_SECRET',
  'WEBHOOK_SECRET_PREVIOUS',
  'PARTNER_API_TOKEN',
  'ADMIN_API_TOKEN',
  'ADMIN_API_KEY',
  'API_KEYS',
  'API_KEY_PEPPER',
  'FLUXORA_WEBHOOK_SECRET',
  'FLUXORA_WEBHOOK_SECRET_PREVIOUS',
]);

/** Parse a value that may be `''` (treated as unset) or a numeric string. */
export function parseInteger(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return value;
  return Number.parseInt(value, 10);
}

/** Parse `'true'/'1'/'false'/'0'` (case-insensitive) into booleans. */
export function parseBoolean(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}

/** Parse a numeric string into a finite number; leave non-numeric input untouched. */
export function parseNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : value;
}

/** Parse human byte sizes (`'64kb'`, `'1mb'`, …) into whole-byte numbers. */
export function byteSizeToNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return value;

  const amount = Number.parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  return Math.floor(amount * (multipliers[unit] ?? 1));
}

/** Required, non-empty, valid absolute URL. */
export function urlString(name: string): ZodString {
  return z
    .string()
    .min(1, `${name} is required`)
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, `${name} must be a valid URL`);
}

/** Optional, valid absolute URL; empty strings are treated as unset. */
export function optionalUrlString(name: string): ZodOptional<ZodString> {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(1, `${name} cannot be empty`)
      .refine((value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      }, `${name} must be a valid URL`)
      .optional()
  );
}

/**
 * Integer with an inclusive minimum (and optional maximum) bound.
 * Error messages carry the variable name for actionable startup failures.
 */
export function integerEnv(
  name: string,
  min: number,
  max?: number
): ZodPreprocess<ZodNumber> | ZodPipe<ZodPreprocess<ZodNumber>, ZodNumber> {
  const schema = z.preprocess(
    parseInteger,
    z.number().int(`${name} must be an integer`).min(min, `${name} must be at least ${min}`)
  );
  return max === undefined
    ? schema
    : schema.pipe(z.number().max(max, `${name} must be at most ${max}`));
}

/** Boolean accepting `true/1/false/0` (case-insensitive). */
export function booleanEnv(): ZodBoolean {
  return z.preprocess(parseBoolean, z.boolean());
}

/** Optional non-empty string; empty strings are treated as unset. */
export function optionalString(name: string): ZodOptional<ZodString> {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1, `${name} cannot be empty`).optional()
  );
}

/**
 * Stellar contract StrKey: `C` + 55 base32 characters, additionally checked
 * against the pinned allowlist via `isValidStellarContractAddress`.
 */
export function requiredStellarContractAddress(name: string): ZodString {
  return z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .regex(/^C[A-Z2-7]{55}$/, `${name} must be a Stellar contract StrKey beginning with C`)
    .refine(isValidStellarContractAddress, `${name} must be a valid Stellar contract StrKey`);
}
