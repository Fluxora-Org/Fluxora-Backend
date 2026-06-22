import { getPool, query } from '../pool.js';
import type { ApiKeyRecord, ApiKeyStoredRecord } from '../types.js';

interface ApiKeyDbRow extends Record<string, unknown> {
  id: string;
  name: string;
  key_hash: string;
  key_salt: string;
  lookup_hash: string;
  prefix: string;
  created_at: Date | string;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
}

export interface PersistApiKeyInput {
  id: string;
  name: string;
  keyHash: string;
  keySalt: string;
  lookupHash: string;
  prefix: string;
  createdAt: string;
  rotatedAt: string | null;
}

export interface RotateApiKeyInput {
  keyHash: string;
  keySalt: string;
  lookupHash: string;
  prefix: string;
  rotatedAt: string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToStoredRecord(row: ApiKeyDbRow): ApiKeyStoredRecord {
  const revokedAt = toIso(row.revoked_at);
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    keySalt: row.key_salt,
    lookupHash: row.lookup_hash,
    prefix: row.prefix,
    createdAt: toIso(row.created_at)!,
    rotatedAt: toIso(row.rotated_at),
    revokedAt,
    active: revokedAt === null,
  };
}

function publicRecord(record: ApiKeyStoredRecord): ApiKeyRecord {
  return {
    id: record.id,
    name: record.name,
    keyHash: record.keyHash,
    prefix: record.prefix,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
    active: record.active,
  };
}

export const apiKeyRepository = {
  async create(input: PersistApiKeyInput): Promise<ApiKeyRecord> {
    const result = await query<ApiKeyDbRow>(
      getPool(),
      `INSERT INTO api_keys (
         id, name, key_hash, key_salt, lookup_hash, prefix,
         created_at, rotated_at, revoked_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
       RETURNING id, name, key_hash, key_salt, lookup_hash, prefix, created_at, rotated_at, revoked_at`,
      [
        input.id,
        input.name,
        input.keyHash,
        input.keySalt,
        input.lookupHash,
        input.prefix,
        input.createdAt,
        input.rotatedAt,
      ],
    );

    return publicRecord(rowToStoredRecord(result.rows[0]!));
  },

  async findById(id: string): Promise<ApiKeyRecord | undefined> {
    const result = await query<ApiKeyDbRow>(
      getPool(),
      `SELECT id, name, key_hash, key_salt, lookup_hash, prefix, created_at, rotated_at, revoked_at
       FROM api_keys
       WHERE id = $1`,
      [id],
    );

    return result.rows[0] ? publicRecord(rowToStoredRecord(result.rows[0])) : undefined;
  },

  async findActiveByLookupHash(lookupHash: string): Promise<ApiKeyStoredRecord[]> {
    const result = await query<ApiKeyDbRow>(
      getPool(),
      `SELECT id, name, key_hash, key_salt, lookup_hash, prefix, created_at, rotated_at, revoked_at
       FROM api_keys
       WHERE lookup_hash = $1 AND revoked_at IS NULL`,
      [lookupHash],
    );

    return result.rows.map((row) => rowToStoredRecord(row));
  },

  async list(): Promise<ApiKeyRecord[]> {
    const result = await query<ApiKeyDbRow>(
      getPool(),
      `SELECT id, name, key_hash, key_salt, lookup_hash, prefix, created_at, rotated_at, revoked_at
       FROM api_keys
       ORDER BY created_at ASC, id ASC`,
    );

    return result.rows.map((row) => publicRecord(rowToStoredRecord(row)));
  },

  async rotate(id: string, input: RotateApiKeyInput): Promise<ApiKeyRecord | undefined> {
    const result = await query<ApiKeyDbRow>(
      getPool(),
      `UPDATE api_keys
       SET key_hash = $2,
           key_salt = $3,
           lookup_hash = $4,
           prefix = $5,
           rotated_at = $6
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id, name, key_hash, key_salt, lookup_hash, prefix, created_at, rotated_at, revoked_at`,
      [id, input.keyHash, input.keySalt, input.lookupHash, input.prefix, input.rotatedAt],
    );

    return result.rows[0] ? publicRecord(rowToStoredRecord(result.rows[0])) : undefined;
  },

  async revoke(id: string, revokedAt: string): Promise<ApiKeyRecord | undefined> {
    const result = await query<ApiKeyDbRow>(
      getPool(),
      `UPDATE api_keys
       SET revoked_at = $2
       WHERE id = $1
       RETURNING id, name, key_hash, key_salt, lookup_hash, prefix, created_at, rotated_at, revoked_at`,
      [id, revokedAt],
    );

    return result.rows[0] ? publicRecord(rowToStoredRecord(result.rows[0])) : undefined;
  },

  async deleteAllForTest(): Promise<void> {
    await query(getPool(), 'DELETE FROM api_keys');
  },
};
