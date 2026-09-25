/**
 * Infrastructure and operations environment variables (RPC circuit breaker,
 * idempotency, S3 backup retention, startup dependency probes, canary
 * rollout, DLQ retention).
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { integerEnv, optionalString } from './parsers.js';

export const infrastructureEnvSchema = {
  /** Failed RPC calls within the window before the circuit opens. @default 5 */
  RPC_CB_FAILURE_THRESHOLD: integerEnv('RPC_CB_FAILURE_THRESHOLD', 1).default(5),
  /** Sliding window for RPC failure counting, in ms. @default 30000 */
  RPC_CB_WINDOW_MS: integerEnv('RPC_CB_WINDOW_MS', 1).default(30000),
  /** Time before an open RPC circuit half-opens, in ms. @default 60000 */
  RPC_CB_RESET_TIMEOUT_MS: integerEnv('RPC_CB_RESET_TIMEOUT_MS', 1).default(60000),
  /** Per-attempt RPC timeout in ms. @default 5000 */
  RPC_TIMEOUT_MS: integerEnv('RPC_TIMEOUT_MS', 1).default(5000),
  /** Retention window for idempotency keys in seconds (max 7 days). @default 86400 */
  IDEMPOTENCY_TTL_SECONDS: integerEnv('IDEMPOTENCY_TTL_SECONDS', 1, 86400 * 7).default(86400),

  /** AWS region for S3 backup uploads (explicit). */
  AWS_REGION: optionalString('AWS_REGION'),
  /** AWS region for S3 backup uploads (SDK fallback variable). */
  AWS_DEFAULT_REGION: optionalString('AWS_DEFAULT_REGION'),
  /** S3 bucket holding database backups. @default unset (backups disabled) */
  S3_BACKUP_BUCKET: optionalString('S3_BACKUP_BUCKET'),
  /** Key prefix under which backups are written in S3_BACKUP_BUCKET. */
  S3_BACKUP_PREFIX: optionalString('S3_BACKUP_PREFIX'),

  /**
   * Tiered startup dependency probing.
   *
   * STARTUP_PROBE_BUDGET_MS          — total wall-clock budget for soft-tier
   *                                    retries (Redis, Stellar RPC) before the
   *                                    service falls back to degraded mode.
   *                                    Default: 30 000 ms. Maximum: 60 000 ms.
   * STARTUP_PROBE_POSTGRES_TIMEOUT_MS — per-attempt timeout for the single
   *                                    Postgres (hard-tier) probe.
   *                                    Default: 5 000 ms.
   * STARTUP_PROBE_REDIS_TIMEOUT_MS   — per-attempt timeout for each Redis
   *                                    (soft-tier) retry attempt.
   *                                    Default: 3 000 ms.
   * STARTUP_PROBE_STELLAR_TIMEOUT_MS — per-attempt timeout for each Stellar
   *                                    RPC (soft-tier) retry attempt.
   *                                    Default: 5 000 ms.
   */
  /** Total wall-clock budget for soft-tier startup retries, in ms. @default 30000 */
  STARTUP_PROBE_BUDGET_MS: integerEnv('STARTUP_PROBE_BUDGET_MS', 1, 60_000).default(30_000),
  /** Per-attempt timeout for the Postgres (hard-tier) probe, in ms. @default 5000 */
  STARTUP_PROBE_POSTGRES_TIMEOUT_MS: integerEnv('STARTUP_PROBE_POSTGRES_TIMEOUT_MS', 1).default(
    5_000
  ),
  /** Per-attempt timeout for each Redis (soft-tier) retry, in ms. @default 3000 */
  STARTUP_PROBE_REDIS_TIMEOUT_MS: integerEnv('STARTUP_PROBE_REDIS_TIMEOUT_MS', 1).default(3_000),
  /** Per-attempt timeout for each Stellar RPC (soft-tier) retry, in ms. @default 5000 */
  STARTUP_PROBE_STELLAR_TIMEOUT_MS: integerEnv('STARTUP_PROBE_STELLAR_TIMEOUT_MS', 1).default(
    5_000
  ),

  /**
   * Percentage of traffic (0–100) to route through the canary code path.
   * 0 disables canary tagging entirely (default). Set to e.g. 10 to tag
   * 10 % of clients deterministically as canary based on a SHA-256 hash
   * of their identity (API key or IP).
   * @default 0
   */
  CANARY_TRAFFIC_PERCENT: integerEnv('CANARY_TRAFFIC_PERCENT', 0, 100).default(0),

  /**
   * Retention period in days for dead_letter_queue entries.
   * Entries in a terminal state (status = 'replayed' or permanently failed)
   * older than this many days are eligible for automatic purge.
   * Defaults to 30 days.  Set to 0 to disable the purge job entirely.
   * @default 30
   */
  DLQ_RETENTION_DAYS: integerEnv('DLQ_RETENTION_DAYS', 1, 365).default(30),

  /**
   * Maximum rows to delete per batch in the DLQ retention purge job.
   * Keeps lock duration short on the dead_letter_queue table.
   * Defaults to 500.
   * @default 500
   */
  DLQ_PURGE_BATCH_SIZE: integerEnv('DLQ_PURGE_BATCH_SIZE', 1, 5000).default(500),
};
