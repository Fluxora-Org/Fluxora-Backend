import { getPool, query } from '../db/pool.js';
import { createId } from '@paralleldrive/cuid2';
import { ApiError } from '../errors.js';

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

const SELECT_COLUMNS = 'id, key_id, max_requests, window_ms, expires_at, created_by, created_at, updated_at';

export async function getOverride(keyId: string): Promise<RateLimitOverride | null> {
  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `SELECT ${SELECT_COLUMNS} FROM tenant_rate_limit_overrides
     WHERE key_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [keyId],
  );
  return result.rows[0] ? rowToOverride(result.rows[0]) : null;
}

export async function createOverride(
  params: CreateOverrideParams,
  createdBy: string,
): Promise<RateLimitOverride> {
  const pool = getPool();
  const id = createId();
  const result = await query<Record<string, unknown>>(
    pool,
    `INSERT INTO tenant_rate_limit_overrides (id, key_id, max_requests, window_ms, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [id, params.keyId, params.maxRequests, params.windowMs, params.expiresAt ?? null, createdBy],
  );
  return rowToOverride(result.rows[0]!);
}

export async function deleteOverride(id: string): Promise<void> {
  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `DELETE FROM tenant_rate_limit_overrides WHERE id = $1 RETURNING id`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(404, 'NOT_FOUND', `Override not found: ${id}`);
  }
}

export async function listOverrides(): Promise<RateLimitOverride[]> {
  const pool = getPool();
  const result = await query<Record<string, unknown>>(
    pool,
    `SELECT ${SELECT_COLUMNS} FROM tenant_rate_limit_overrides ORDER BY created_at DESC`,
  );
  return result.rows.map(rowToOverride);
}
