import { getRuntimeEnv } from '../config/runtime-env.js';
import { getPool, query } from '../db/pool.js';
import { createId } from '@paralleldrive/cuid2';
import { ApiError, ApiErrorCode, validationError } from '../errors.js';
import { getOverrideCeiling, type OverrideCeiling } from '../config/rateLimits.js';

export interface RateLimitOverride {
  id: string;
  keyId: string;
  maxRequests: number;
  windowMs: number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOverrideParams {
  keyId: string;
  maxRequests: number;
  windowMs: number;
  expiresAt?: string;
}

function rowToOverride(row: Record<string, unknown>): RateLimitOverride {
  return {
    id: row['id'] as string,
    keyId: row['key_id'] as string,
    maxRequests: row['max_requests'] as number,
    windowMs: row['window_ms'] as number,
    expiresAt: row['expires_at'] ? (row['expires_at'] as Date).toISOString() : null,
    createdBy: row['created_by'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
}

const SELECT_COLUMNS =
  'id, key_id, max_requests, window_ms, expires_at, created_by, created_at, updated_at';
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_REQUESTS_UPPER_BOUND = 10_000_000;
const MIN_WINDOW_MS = 1_000;

function validateIdentifier(fieldName: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${fieldName} must be a non-empty string`, { field: fieldName, value });
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw validationError(`${fieldName} is too long`, {
      field: fieldName,
      length: value.length,
      maxLength: MAX_IDENTIFIER_LENGTH,
    });
  }
}

function validateCreateOverrideParams(params: CreateOverrideParams): void {
  if (params === null || typeof params !== 'object') {
    throw validationError('Override payload must be an object', { received: params });
  }

  validateIdentifier('keyId', params.keyId);

  if (!Number.isInteger(params.maxRequests) || params.maxRequests <= 0) {
    throw validationError('maxRequests must be a positive integer', {
      field: 'maxRequests',
      value: params.maxRequests,
    });
  }

  if (params.maxRequests > MAX_REQUESTS_UPPER_BOUND) {
    throw validationError(`maxRequests must not exceed ${MAX_REQUESTS_UPPER_BOUND}`, {
      field: 'maxRequests',
      value: params.maxRequests,
      maxAllowed: MAX_REQUESTS_UPPER_BOUND,
    });
  }

  if (!Number.isInteger(params.windowMs) || params.windowMs < MIN_WINDOW_MS) {
    throw validationError(`windowMs must be an integer of at least ${MIN_WINDOW_MS} milliseconds`, {
      field: 'windowMs',
      value: params.windowMs,
      minValue: MIN_WINDOW_MS,
    });
  }

  if (params.expiresAt !== undefined && params.expiresAt !== null) {
    const parsed = Date.parse(params.expiresAt);
    if (!Number.isFinite(parsed)) {
      throw validationError('expiresAt must be a valid ISO-8601 timestamp', {
        field: 'expiresAt',
        value: params.expiresAt,
      });
    }
  }
}

/**
 * Look up an active override by tenant key ID.
 *
 * Returns null if no override exists for the given keyId, or if the most
 * recent override has expired.  Expiry is evaluated server-side (NOW()) so
 * the result is always consistent with the database clock regardless of
 * application-server clock skew.
 */
export async function getOverride(keyId: string): Promise<RateLimitOverride | null> {
  validateIdentifier('keyId', keyId);

  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `SELECT ${SELECT_COLUMNS} FROM tenant_rate_limit_overrides
     WHERE key_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [keyId]
  );
  return result.rows[0] ? rowToOverride(result.rows[0]) : null;
}

/**
 * Look up a single override by its primary-key ID.
 *
 * Returns null when the record does not exist or has expired.  This mirrors
 * the expiry semantics of getOverride() so the two functions stay consistent:
 * an expired record is treated as absent by all read paths.
 */
export async function getOverrideById(id: string): Promise<RateLimitOverride | null> {
  validateIdentifier('id', id);

  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `SELECT ${SELECT_COLUMNS} FROM tenant_rate_limit_overrides
     WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [id]
  );
  return result.rows[0] ? rowToOverride(result.rows[0]) : null;
}

/**
 * Assert that an override stays within the global ceiling.
 *
 * Overrides are tighten-only: a tenant override replaces the global API-key
 * tier config on the request path, so accepting a `maxRequests` above that
 * tier's limit would promote a protective global limit into a per-tenant
 * setting.  A breach is refused before any row is written, and the route layer
 * audits the refusal.
 *
 * `ceiling` is injectable so callers/tests can pin the bound; production call
 * sites resolve the live global config via getOverrideCeiling().
 */
export function assertOverrideWithinCeiling(
  params: Pick<CreateOverrideParams, 'maxRequests' | 'windowMs'>,
  ceiling: OverrideCeiling = getOverrideCeiling(
    getRuntimeEnv() as Record<string, string | undefined>
  )
): void {
  if (params.maxRequests > ceiling.maxRequests) {
    throw new ApiError(
      422,
      ApiErrorCode.UNPROCESSABLE_ENTITY,
      `maxRequests ${params.maxRequests} exceeds the global ceiling of ${ceiling.maxRequests}`,
      { maxRequests: params.maxRequests, ceiling: ceiling.maxRequests }
    );
  }
  if (params.windowMs > ceiling.windowMs) {
    throw new ApiError(
      422,
      ApiErrorCode.UNPROCESSABLE_ENTITY,
      `windowMs ${params.windowMs} exceeds the maximum allowed window of ${ceiling.windowMs}`,
      { windowMs: params.windowMs, ceiling: ceiling.windowMs }
    );
  }
}

export async function createOverride(
  params: CreateOverrideParams,
  createdBy: string
): Promise<RateLimitOverride> {
  validateCreateOverrideParams(params);
  validateIdentifier('createdBy', createdBy);
  assertOverrideWithinCeiling(params);

  const pool = getPool();
  const id = createId();
  const result = await query<Record<string, unknown>>(
    pool,
    `INSERT INTO tenant_rate_limit_overrides (id, key_id, max_requests, window_ms, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [id, params.keyId, params.maxRequests, params.windowMs, params.expiresAt ?? null, createdBy]
  );
  return rowToOverride(result.rows[0]!);
}

/**
 * Delete an override by primary-key ID.
 *
 * Returns the deleted record so callers (e.g. the route handler) can include
 * stable identifiers like keyId in their audit logs without needing a
 * separate pre-delete read.  Throws a 404 ApiError if the record does not
 * exist.
 */
export async function deleteOverride(id: string): Promise<RateLimitOverride> {
  validateIdentifier('id', id);

  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `DELETE FROM tenant_rate_limit_overrides WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id]
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, 'NOT_FOUND', `Override not found: ${id}`);
  }
  return rowToOverride(result.rows[0]!);
}

/**
 * List all active overrides ordered by creation date, newest first.
 *
 * Only non-expired records are returned.  Expired overrides are excluded
 * from this listing so the response accurately reflects the set of overrides
 * that are currently in effect, consistent with the expiry semantics applied
 * by getOverride() and getOverrideById().
 */
export async function listOverrides(): Promise<RateLimitOverride[]> {
  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `SELECT ${SELECT_COLUMNS} FROM tenant_rate_limit_overrides
     WHERE expires_at IS NULL OR expires_at > NOW()
     ORDER BY created_at DESC`
  );
  return result.rows.map(rowToOverride);
}
