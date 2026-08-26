/**
 * Webhook Secret Repository — PostgreSQL-backed persistence for webhook signing
 * secret rotation state.
 *
 * During a secret rotation the *previous* secret must remain valid for a bounded
 * grace window so that producers still signing with the old secret are not
 * rejected. The rotation timestamp and grace-window expiry are persisted here
 * (not held in memory) so that a process restart cannot silently extend or
 * shrink the window.
 *
 * Table: `webhook_secrets`
 *
 * Mirrors {@link ./apiKeyRepository} conventions: every public method is async
 * and uses the shared pg Pool from src/db/pool.ts.
 *
 * @module db/repositories/webhookSecretRepository
 */

import { getPool, query } from '../pool.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Persisted state for a single webhook signing secret.
 *
 * `previousSecretRotatedAt` and `previousSecretExpiresAt` are stored as Unix
 * timestamps (seconds) so the verification path can compute the grace window
 * without any date parsing.
 */
export interface WebhookSecretState {
  /** Stable identifier for this secret entry (e.g. tenant or 'default'). */
  id: string;
  /** The current signing secret. */
  currentSecret: string;
  /** The previous signing secret, valid only during the grace window. */
  previousSecret: string | null;
  /** Unix timestamp (seconds) when the previous secret was rotated out. */
  previousSecretRotatedAt: number | null;
  /** Unix timestamp (seconds) when the grace window expires. */
  previousSecretExpiresAt: number | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
}

/**
 * Input for {@link WebhookSecretRepository.rotateSecret}.
 */
export interface RotateSecretInput {
  /** The new signing secret to activate. */
  newSecret: string;
  /**
   * Grace window (seconds) during which the old secret remains valid after
   * rotation. Defaults to 86 400 (24 hours).
   */
  graceWindowSeconds?: number;
  /**
   * Unix timestamp (seconds) at which the rotation occurs. Defaults to
   * `Math.floor(Date.now() / 1000)`.
   */
  rotatedAt?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const SELECT_COLUMNS =
  'id, current_secret, previous_secret, previous_secret_rotated_at, previous_secret_expires_at, created_at, updated_at';

/** Map a raw pg row to a typed {@link WebhookSecretState}. */
function rowToState(row: Record<string, unknown>): WebhookSecretState {
  return {
    id: row['id'] as string,
    currentSecret: row['current_secret'] as string,
    previousSecret: (row['previous_secret'] as string | null) ?? null,
    previousSecretRotatedAt:
      row['previous_secret_rotated_at'] !== null &&
      row['previous_secret_rotated_at'] !== undefined
        ? Number(row['previous_secret_rotated_at'])
        : null,
    previousSecretExpiresAt:
      row['previous_secret_expires_at'] !== null &&
      row['previous_secret_expires_at'] !== undefined
        ? Number(row['previous_secret_expires_at'])
        : null,
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
}

// ── Repository ────────────────────────────────────────────────────────────────

export const webhookSecretRepository = {
  /**
   * Create the `webhook_secrets` table if it does not already exist.
   *
   * This is self-contained so the repository can be used without a separate
   * migration file. In production deployments the table is expected to be
   * created by a migration; calling this method is idempotent and safe.
   */
  async ensureSchema(): Promise<void> {
    const pool = getPool();
    await query(
      pool,
      `CREATE TABLE IF NOT EXISTS webhook_secrets (
         id                            TEXT PRIMARY KEY,
         current_secret                TEXT NOT NULL,
         previous_secret               TEXT,
         previous_secret_rotated_at    INTEGER,
         previous_secret_expires_at    INTEGER,
         created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    // Keep updated_at in sync on row updates.
    await query(
      pool,
      `CREATE INDEX IF NOT EXISTS idx_webhook_secrets_updated_at ON webhook_secrets (updated_at)`,
    );
  },

  /**
   * Fetch the secret state for the given identifier.
   * Returns `undefined` when no row exists.
   */
  async getSecretState(id: string): Promise<WebhookSecretState | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `SELECT ${SELECT_COLUMNS} FROM webhook_secrets WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToState(result.rows[0]) : undefined;
  },

  /**
   * Insert a brand-new secret entry (no previous secret).
   * Throws `DuplicateEntryError` if the id already exists.
   */
  async setSecret(id: string, secret: string): Promise<WebhookSecretState> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `INSERT INTO webhook_secrets (id, current_secret, previous_secret, previous_secret_rotated_at, previous_secret_expires_at)
       VALUES ($1, $2, NULL, NULL, NULL)
       RETURNING ${SELECT_COLUMNS}`,
      [id, secret],
    );
    return rowToState(result.rows[0]);
  },

  /**
   * Rotate the signing secret: the current secret becomes the previous secret
   * (with rotation timestamp and grace-window expiry), and `newSecret` becomes
   * the current secret.
   *
   * Returns the updated state. Throws `DuplicateEntryError` if the id does not
   * exist (the caller should `setSecret` first).
   */
  async rotateSecret(
    id: string,
    input: RotateSecretInput,
  ): Promise<WebhookSecretState> {
    const graceWindowSeconds = input.graceWindowSeconds ?? 86_400;
    const rotatedAt = input.rotatedAt ?? Math.floor(Date.now() / 1000);
    const expiresAt = rotatedAt + graceWindowSeconds;

    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `UPDATE webhook_secrets
          SET current_secret = $2,
              previous_secret = current_secret,
              previous_secret_rotated_at = $3,
              previous_secret_expires_at = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id, input.newSecret, rotatedAt, expiresAt],
    );
    if (!result.rows[0]) {
      throw new Error(`Cannot rotate secret: no row with id "${id}"`);
    }
    return rowToState(result.rows[0]);
  },

  /**
   * Clear the previous secret once its grace window has expired.
   *
   * This is a cleanup operation — after the grace window the previous secret is
   * no longer needed and should be removed so it cannot be used even if the
   * verification path is misconfigured.
   *
   * Returns `true` if the previous secret was cleared, `false` if it was still
   * within the grace window or already null.
   */
  async clearExpiredPreviousSecret(
    id: string,
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `UPDATE webhook_secrets
          SET previous_secret = NULL,
              previous_secret_rotated_at = NULL,
              previous_secret_expires_at = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND previous_secret IS NOT NULL
          AND previous_secret_expires_at IS NOT NULL
          AND previous_secret_expires_at <= $2`,
      [id, now],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Delete the secret state entirely.
   * Returns `true` if a row was deleted.
   */
  async deleteSecretState(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await query(
      pool,
      `DELETE FROM webhook_secrets WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
