/**
 * API Key Repository — PostgreSQL-backed CRUD for the `api_keys` table.
 *
 * Mirrors {@link ./streamRepository} conventions: every public method is async
 * and uses the shared pg Pool from src/db/pool.ts.
 *
 * Security invariants
 * -------------------
 * - Only the salted/peppered `key_hash` is stored — never the raw key.
 * - {@link apiKeyRepository.findActiveByPrefix} drives O(log n) validation via
 *   the indexed `prefix` column instead of a full-table scan.
 *
 * @module db/repositories/apiKeyRepository
 */

import { getPool, query } from '../pool.js';
import type { ApiKeyRecord } from '../types.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Map a raw pg row to a typed {@link ApiKeyRecord}. */
function rowToRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id:        row['id']     as string,
    name:      row['name']   as string,
    keyHash:   row['key_hash'] as string,
    salt:      row['salt']   as string,
    prefix:    row['prefix'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
    rotatedAt: row['rotated_at'] ? (row['rotated_at'] as Date).toISOString() : null,
    active:    row['active'] as boolean,
  };
}

const SELECT_COLUMNS = 'id, name, key_hash, salt, prefix, created_at, rotated_at, active';

// ── Repository ────────────────────────────────────────────────────────────────

export const apiKeyRepository = {
  /** Insert a freshly created API key record. */
  async insert(record: ApiKeyRecord): Promise<void> {
    const pool = getPool();
    await query(
      pool,
      `INSERT INTO api_keys (id, name, key_hash, salt, prefix, created_at, rotated_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.name,
        record.keyHash,
        record.salt,
        record.prefix,
        record.createdAt,
        record.rotatedAt,
        record.active,
      ],
    );
  },

  /**
   * Fetch active key candidates matching a prefix. Returns 0..n rows — more than
   * one only on the rare prefix collision, which callers disambiguate with a
   * constant-time hash comparison. Driven by the `api_keys_prefix_active_idx`
   * index, so this never scans the whole table.
   */
  async findActiveByPrefix(prefix: string): Promise<ApiKeyRecord[]> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE prefix = $1 AND active = true`,
      [prefix],
    );
    return result.rows.map(rowToRecord);
  },

  /** Fetch a single key by its primary key. */
  async getById(id: string): Promise<ApiKeyRecord | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  },

  /**
   * Replace the hash material of an existing key (rotation) and stamp
   * `rotated_at`. Returns the updated record, or `undefined` if no row matched.
   */
  async rotate(
    id: string,
    patch: { keyHash: string; salt: string; prefix: string; rotatedAt: string },
  ): Promise<ApiKeyRecord | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `UPDATE api_keys
         SET key_hash = $2, salt = $3, prefix = $4, rotated_at = $5
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, patch.keyHash, patch.salt, patch.prefix, patch.rotatedAt],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  },

  /**
   * Deactivate a key so it can no longer authenticate. Returns the updated
   * record, or `undefined` if no row matched.
   */
  async revoke(id: string): Promise<ApiKeyRecord | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `UPDATE api_keys SET active = false WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  },

  /** Return all key records (active and revoked), newest first. */
  async listAll(): Promise<ApiKeyRecord[]> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `SELECT ${SELECT_COLUMNS} FROM api_keys ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToRecord);
  },
};
