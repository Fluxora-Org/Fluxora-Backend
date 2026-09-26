// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { ContractEvent, ReplayCursor } from '../types/index.js';
import { rowReader, INT32_MAX, BIGINT_SAFE_MAX } from '../db/rowMapping.js';

// ── Row mappers (pg QueryResultRow → domain types) ────────────────────────────
//
// Never pass a bare domain interface to `client.query<T>()`.  pg requires
// `QueryResultRow` (an index signature); domain interfaces do not satisfy it.
// Query with `Record<string, unknown>` and map through these helpers instead.
// See `src/db/repositories/README.md`.

/**
 * Lenient timestamp coercion, retained only for `getReplayProgressExtended`,
 * whose mapper is out of scope for issue #1316 and is guarded by its own
 * try/catch. New mappers must use the readers in `src/db/rowMapping.ts`.
 */
export function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Map a raw `replay_cursors` row into a typed {@link ReplayCursor}.
 *
 * The nullability contract comes from
 * `migrations/1000000000002_create_replay_cursors.ts`:
 *
 * | Column                  | Type          | Nullable |
 * | ----------------------- | ------------- | -------- |
 * | `id`                    | `uuid` PK     | no       |
 * | `contract_id`           | `text`        | no       |
 * | `ledger`                | `integer`     | no       |
 * | `from_block`            | `integer`     | **yes**  |
 * | `to_block`              | `integer`     | **yes**  |
 * | `total_rows`            | `integer`     | no       |
 * | `last_committed_offset` | `integer`     | no       |
 * | `started_at`            | `timestamptz` | no       |
 * | `completed_at`          | `timestamptz` | **yes**  |
 *
 * Block heights, ledger sequences, row counts and offsets are non-negative by
 * construction, so the readers are bounded to `[0, INT32_MAX]`. A negative or
 * out-of-range value means the row is corrupt, and a corrupt cursor silently
 * read as `0` would restart a replay from the beginning and re-emit every
 * event — the exact failure this mapper now refuses to produce.
 *
 * @throws {RowMappingError} if any column violates the contract above.
 */
export function rowToReplayCursor(row: Record<string, unknown>): ReplayCursor {
  const r = rowReader('replay_cursors', row);
  const bounds = { min: 0, max: INT32_MAX };

  return {
    id:                    r.requireString('id'),
    contract_id:           r.requireString('contract_id'),
    ledger:                r.requireInt('ledger', bounds),
    from_block:            r.optionalInt('from_block', bounds),
    to_block:              r.optionalInt('to_block', bounds),
    total_rows:            r.requireInt('total_rows', bounds),
    last_committed_offset: r.requireInt('last_committed_offset', bounds),
    started_at:            r.requireDate('started_at'),
    completed_at:          r.optionalDate('completed_at'),
  };
}

/**
 * Map a raw `historical_events` row into a typed {@link ContractEvent}.
 *
 * The nullability contract comes from
 * `migrations/1000000000000_initial_schema.ts`:
 *
 * | Column             | Type        | Nullable |
 * | ------------------ | ----------- | -------- |
 * | `event_id`         | `text` PK   | no       |
 * | `contract_id`      | `text`      | no       |
 * | `ledger`           | `integer`   | no       |
 * | `event_type`       | `text`      | no       |
 * | `event_data`       | `jsonb`     | no       |
 * | `block_height`     | `bigint`    | no       |
 * | `transaction_hash` | `text`      | no       |
 * | `created_at`       | `timestamp` | **yes**  |
 *
 * `ingested_at` and `created_at` are read only when the column is present on
 * the row. That distinction is deliberate: `fetchEventBatch` does not select
 * them, and an absent column must stay absent from the domain object rather
 * than materialise as a fabricated timestamp. A column that *is* selected and
 * holds NULL maps to `null`, because the schema permits it.
 *
 * `block_height` is a `bigint`, so it is bounded by the safe-integer range
 * instead of int4 — `Number('9007199254740993')` rounds down silently, and a
 * replay ordered by a rounded block height would skip or repeat events.
 *
 * Failure policy: fail fast. The single caller is `fetchEventBatch`, whose
 * rows are inserted straight into `contract_events`. Today a corrupt row is
 * coerced and then either rejected by Postgres with an opaque `invalid input
 * syntax for type bigint: "NaN"` or — worse — inserted with a silently
 * defaulted `ledger` of 0. Throwing here surfaces the same batch failure with
 * the table, column and reason named, and prevents the second case entirely.
 *
 * @throws {RowMappingError} if any column violates the contract above.
 */
export function rowToContractEvent(row: Record<string, unknown>): ContractEvent {
  const r = rowReader('historical_events', row);

  return {
    event_id:         r.requireString('event_id'),
    contract_id:      r.requireString('contract_id'),
    ledger:           r.requireInt('ledger', { min: 0, max: INT32_MAX }),
    event_type:       r.requireString('event_type'),
    event_data:       r.requireJsonObject('event_data'),
    block_height:     r.requireInt('block_height', { min: 0, max: BIGINT_SAFE_MAX }),
    transaction_hash: r.requireString('transaction_hash'),
    ...(row['ingested_at'] !== undefined
      ? { ingested_at: r.optionalDate('ingested_at') }
      : {}),
    ...(row['created_at'] !== undefined
      ? { created_at: r.optionalDate('created_at') }
      : {}),
  };
}
