/**
 * Data-retention manifest — the single source of truth for how long the
 * service keeps each class of persisted data.
 *
 * @module pii/retention
 *
 * ## Why this module exists
 *
 * Retention was previously implied by four independent places:
 *
 *  - `src/jobs/retentionPurge.ts`  — table-driven row purges
 *  - `src/jobs/dlqPurge.ts`        — dead-letter-queue purges
 *  - `src/routes/privacy.ts`       — the public `/api/privacy/retention` view
 *  - `src/pii/policy.ts`           — the classification/retention constants
 *
 * plus the monthly partitions of `contract_events`, which accumulate
 * indefinitely. Nothing stated the periods together, so a subject-access or
 * erasure request could not be answered from the codebase with confidence.
 *
 * This module closes that gap:
 *
 *  1. {@link RETENTION_MANIFEST} lists **every** persisted data class, with a
 *     period, the mechanism that enforces it, and whether a legal hold can
 *     override it.
 *  2. {@link PURGEABLE_RETENTION_SCHEDULE} — the rule list consumed by
 *     `src/jobs/retentionPurge.ts` — is **derived** from the manifest rather
 *     than written by hand, so the schedule the job enforces and the schedule
 *     that is published cannot drift apart.
 *  3. `docs/retention-schedule.md` renders the same manifest, and
 *     `scripts/check-retention-schedule.ts` fails CI when the document, the
 *     manifest, the migrations and the purge jobs disagree.
 *
 * ## Retention vocabulary
 *
 * `retentionDays: null` means **indefinite** — the service makes no deletion
 * commitment for that data class. This is a deliberate, reviewed decision
 * (chain-derived state mirrors immutable public ledger data; credential and
 * consent tables hold one row per subject and are superseded in place), not
 * an omission. A finite period with no enforcing mechanism is only permitted
 * when the entry carries an `unenforcedReason`, which is rendered into the
 * published document and enforced as non-empty by the CI check.
 */

import { DataClassification } from './classification.js';

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * How — or whether — the retention period for a data class is enforced.
 *
 * - `retention-purge` — `src/jobs/retentionPurge.ts` deletes or redacts rows
 *   past the cut-off. Rules are generated into
 *   {@link PURGEABLE_RETENTION_SCHEDULE} from these entries.
 * - `dlq-purge` — `src/jobs/dlqPurge.ts` deletes terminal-state rows. The
 *   window comes from `DLQ_RETENTION_DAYS`; the value recorded here is the
 *   shipped default that the CI check asserts against the env schema.
 * - `expires-column` — the row carries its own expiry (`expires_at`) and stops
 *   applying at that instant. No scheduled job is required.
 * - `ttl` — the backing store evicts the entry itself (Redis `EX`, an
 *   in-process timer). Nothing to run.
 * - `operator` — deletion is an explicit, audited operator action (a
 *   management-API call, or a confirmed destructive maintenance script).
 * - `external` — the data lives outside this service (log aggregator, S3
 *   backups) and is governed by the operator's configuration. Listed here so
 *   the schedule is complete; the code cannot enforce it.
 * - `none` — no enforcement mechanism. Legal only for an indefinite period, or
 *   for a finite period that carries an `unenforcedReason`.
 */
export type RetentionEnforcement =
  | 'retention-purge'
  | 'dlq-purge'
  | 'expires-column'
  | 'ttl'
  | 'operator'
  | 'external'
  | 'none';

/** What the purge does to a row once its window expires. */
export type PurgeAction = 'delete' | 'redact' | 'expire' | 'none';

/**
 * One row of the retention manifest: a single class of data the service
 * persists, together with the commitment made about it.
 */
export interface DataRetentionRule {
  /**
   * Stable machine identifier. Used as the key in the published document and
   * as the cross-reference in the CI check, so it must not be renamed once
   * published.
   */
  id: string;

  /** Human-readable name of the data class, as shown in the document. */
  dataClass: string;

  /**
   * The PostgreSQL table backing this class, or `null` for data that lives
   * outside the database (logs, backups, in-process caches).
   */
  table: string | null;

  /**
   * Where the data is stored, e.g. `PostgreSQL — streams`, `Redis`,
   * `S3 (operator-managed)`, `process memory`.
   */
  storage: string;

  /**
   * Maximum age in days before the data is deleted or redacted.
   * `null` means indefinite — see the module docs.
   */
  retentionDays: number | null;

  /**
   * Column the cut-off is computed from, for rules a scheduled job enforces.
   * Must be a real column on `table`; the CI check asserts it.
   */
  ageColumn?: string;

  /** What happens to an expired row. */
  purgeAction: PurgeAction;

  /** Which mechanism enforces `retentionDays`. */
  enforcement: RetentionEnforcement;

  /**
   * Pointer to the thing that does the enforcing: a module path, an env var,
   * or a management route. Rendered into the document so an auditor can go
   * straight to the implementation.
   */
  enforcementRef: string;

  /**
   * Whether a legal hold can suspend the deletion of this class.
   *
   * True only where the table actually carries a `legal_hold` column, because
   * the purge job's hold check is a column read. See
   * {@link LEGAL_HOLD_EXEMPT_TABLES}.
   */
  legalHoldExempt: boolean;

  /** Why this period, and what it is derived from. */
  rationale: string;

  /**
   * Required when a finite period is declared with no enforcing mechanism
   * (`enforcement: 'none'`). Rendered into the published document and
   * enforced as non-empty by `scripts/check-retention-schedule.ts`, so a gap
   * cannot be published without also publishing why it is still open.
   */
  unenforcedReason?: string;

  /**
   * Highest-sensitivity classification present in this data class, taken from
   * {@link DataClassification}. Mirrors the field-level policy so a
   * subject-access response can be answered without cross-referencing two
   * documents.
   */
  classification: DataClassification;

  /**
   * Migration that introduced `table`, or `null` for non-database data.
   * Purely documentary — used to help a reviewer find the schema.
   */
  migration?: string;
}

/**
 * Tables that carry a `legal_hold` column, and therefore support a legal-hold
 * exemption.
 *
 * `streams` is the only one: the column was added by
 * `migrations/20260724000000_streams_legal_hold.ts` and no other table has
 * ever received it. `runRetentionPurge` discovers the column at runtime
 * (`tableHasColumn`) and substitutes a constant `FALSE` for tables that lack
 * it, so a `legalHoldExempt: false` entry is purged unconditionally rather
 * than being silently skipped.
 */
export const LEGAL_HOLD_EXEMPT_TABLES: readonly string[] = ['streams'];

/**
 * The legal-hold exemption, in the shape the privacy endpoint publishes it.
 *
 * A hold is the one thing that can suspend a retention commitment, so it is
 * described next to the schedule rather than left implicit in the purge job's
 * module docs. A subject-access response has to be able to say "this data is
 * past its period but retained because a hold applies" and point at who can
 * impose and lift one.
 */
export const LEGAL_HOLD_POLICY = {
  /** Column that carries the flag, where it exists. */
  column: 'legal_hold',
  /** Tables that have the column, and therefore honour a hold. */
  exemptTables: [...LEGAL_HOLD_EXEMPT_TABLES],
  /**
   * Tables whose retention period cannot be suspended, and why. A row in one
   * of these is deleted when its window closes whether or not anyone objects,
   * so a hold placed on it would be silently ineffective.
   */
  nonExemptNote:
    'A legal hold only applies to the tables listed in exemptTables. Every other data class ' +
    'is deleted on schedule regardless of a hold, because those tables carry no legal_hold ' +
    'column for one to live in. If a hold must cover audit_logs, webhook_dlq or any other ' +
    'table, it has to be implemented at that table before it can be honoured.',
  /** How a hold is honoured, and what evidence is produced. */
  enforcement:
    'runRetentionPurge reads legal_hold inside the same transaction as the delete, so a hold ' +
    'cannot be set between the check and the delete. A held row is left untouched and a ' +
    'PURGE_SKIPPED_LEGAL_HOLD audit event is written for it, every run, until the hold is ' +
    'lifted. The erasure endpoint applies the same rule and reports the skipped count.',
  /** The only way a held row becomes purgeable again. */
  release: 'An operator must clear legal_hold on the row; the next purge run then deletes it.',
} as const;

// ── Backwards-compatible rule shapes ──────────────────────────────────────────

/**
 * The historical retention-rule shape, preserved because
 * `src/pii/policy.ts` and `src/jobs/retentionPurge.ts` are typed against it.
 */
export interface RetentionRule {
  /** Category label shown in the privacy endpoint. */
  category: string;
  /** Maximum number of days data in this category is retained. null = indefinite. */
  retentionDays: number | null;
  /** Where the data lives (memory, database, external chain). */
  storageLayer: string;
  /** Justification for the retention window. */
  rationale: string;
}

/**
 * A {@link RetentionRule} that the scheduled purge job can actively enforce.
 *
 * The extra fields tell the job:
 *  - which database table to target (`table`)
 *  - which column records the row's age (`ageColumn`) — the job compares
 *    this against `now - retentionDays days`
 *  - how to purge rows whose retention window has expired (`purgeAction`):
 *      `delete`  — hard-delete the row entirely (use for ephemeral metadata).
 *      `redact`  — overwrite PII columns with a placeholder and mark the row
 *                  redacted (use when the row must stay for audit integrity
 *                  but its sensitive fields must not persist).
 */
export interface PurgeableRetentionRule extends RetentionRule {
  /** Fully-qualified table name the purge job operates on. */
  table: string;
  /** Column used to determine the age of a row for the cut-off calculation. */
  ageColumn: string;
  /** Purge strategy for an expired row. */
  purgeAction: 'delete' | 'redact';
}

// ── The manifest ──────────────────────────────────────────────────────────────

/**
 * Every class of data the service persists, and the commitment made about it.
 *
 * Ordered by data class. When adding an entry:
 *
 *  1. Give it a stable kebab-case `id` and a `rationale` that names the basis
 *     for the number (a regulation, a debug window, an unbounded-growth
 *     guard) rather than restating the number.
 *  2. Point `enforcement` at the mechanism that actually deletes the rows. If
 *     nothing does, say so with `unenforcedReason` — the CI check will reject
 *     an empty one.
 *  3. Set `legalHoldExempt: true` only if the table really has the column.
 *  4. Re-run `pnpm run check:retention` and update
 *     `docs/retention-schedule.md` with `pnpm run check:retention -- --write`.
 */
export const RETENTION_MANIFEST: readonly DataRetentionRule[] = [
  // ── Credentials and consent ────────────────────────────────────────────────
  {
    id: 'api-keys',
    dataClass: 'API key records',
    table: 'api_keys',
    storage: 'PostgreSQL — api_keys',
    retentionDays: null,
    purgeAction: 'none',
    enforcement: 'operator',
    enforcementRef: 'DELETE /api/admin/api-keys/:id (src/routes/admin.ts) — sets active = false',
    legalHoldExempt: false,
    classification: DataClassification.RESTRICTED,
    migration: 'migrations/20260623000000_api-keys.ts',
    rationale:
      'A credential must remain verifiable for as long as it can authenticate, so no ' +
      'time-based cut-off is declared. Only the HMAC-SHA256 hash, a per-key salt and an ' +
      '8-character prefix are stored; the raw key is never persisted, so the row is not ' +
      'usable to impersonate the holder after revocation. Revocation is a soft delete ' +
      '(active = false) performed through the audited admin route, and the revoked row is ' +
      'kept for the credential-lifecycle audit trail.',
  },
  {
    id: 'privacy-consents',
    dataClass: 'Consent preferences',
    table: 'privacy_consents',
    storage: 'PostgreSQL — privacy_consents',
    retentionDays: null,
    purgeAction: 'none',
    enforcement: 'operator',
    enforcementRef: 'PUT /api/privacy/consent (src/routes/privacy.ts) — overwrites in place',
    legalHoldExempt: false,
    classification: DataClassification.SENSITIVE,
    migration: 'migrations/20260725000000_privacy_consents.ts',
    rationale:
      'One row per data subject, keyed by a keyed HMAC of the address — the plaintext ' +
      'address is never stored. The table is bounded by the number of subjects rather than ' +
      'by traffic, and each PUT overwrites the existing row, so no time-based purge is ' +
      'needed. A withdrawal must remain provable, so consent records are superseded rather ' +
      'than expired.',
  },

  // ── Stream data ────────────────────────────────────────────────────────────
  {
    id: 'streams-pii',
    dataClass: 'Stream address PII',
    table: 'streams',
    storage: 'PostgreSQL — streams',
    retentionDays: 365,
    ageColumn: 'created_at',
    purgeAction: 'redact',
    enforcement: 'retention-purge',
    enforcementRef: 'src/jobs/retentionPurge.ts — redact rule "Stream address PII"',
    legalHoldExempt: true,
    classification: DataClassification.SENSITIVE,
    migration: 'migrations/1774715131962_streams-table.ts',
    rationale:
      'Sender and recipient addresses are pseudonymous but correlatable identifiers. The ' +
      'financial columns must survive indefinitely for audit integrity, so the PII columns ' +
      'are overwritten with a tombstone in place after one year instead of deleting the row. ' +
      'One year bounds the exposure window for a correlatable identifier while keeping the ' +
      'amount and ledger references that a financial record requires.',
  },
  {
    id: 'streams-chain-state',
    dataClass: 'Stream records (chain-derived)',
    table: 'streams',
    storage: 'PostgreSQL — streams',
    retentionDays: null,
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — the non-PII remainder of a streams row is retained with the chain state it mirrors',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    rationale:
      'The non-PII remainder of the same rows (amount, ledger, status, contract id) mirrors ' +
      'immutable public Stellar state. Deleting it would create an inconsistency with ' +
      'Horizon and with the smart contract, so the commitment is indefinite. Address columns ' +
      'within these rows are covered by the "Stream address PII" entry above.',
  },

  // ── Chain ingest ───────────────────────────────────────────────────────────
  {
    id: 'contract-events',
    dataClass: 'Contract events (partitioned)',
    table: 'contract_events',
    storage: 'PostgreSQL — contract_events (RANGE-partitioned by month)',
    retentionDays: null,
    ageColumn: 'ingested_at',
    purgeAction: 'none',
    enforcement: 'operator',
    enforcementRef: 'src/scripts/db-ops.ts — dropOldPartitions (manual, confirmed, dry-run by default)',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1000000000000_initial_schema.ts, migrations/20260627000000_contract_events_partitioning.ts',
    rationale:
      'Replays and reorg resolution need history, and every row is a public ledger event. ' +
      'No automatic cut-off is declared. Monthly partitions are pre-created by ' +
      'src/jobs/partitionMaintenance.ts and can be dropped with dropOldPartitions, which ' +
      'requires an explicit environment confirmation and defaults to a dry run — so ' +
      'shortening this period is an operator action that is recorded, not a silent job.',
  },
  {
    id: 'contract-events-default-partition',
    dataClass: 'Contract events — DEFAULT partition',
    table: 'contract_events_default',
    storage: 'PostgreSQL — contract_events_default (fallback partition)',
    retentionDays: null,
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — inherits the indefinite period of contract_events; emptied by repairing the ' +
      'partition shortfall the alert points at',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/20260627000000_contract_events_partitioning.ts',
    rationale:
      'Holds only rows whose timestamp fell outside every pre-created monthly range. It is ' +
      'unindexed and its presence is an alert condition (partition_shortfall_detected), not a ' +
      'durable data class: it inherits the indefinite period of contract_events and must be ' +
      'emptied by the partition fix the alert points at.',
  },
  {
    id: 'historical-events',
    dataClass: 'Historical events (ingest source)',
    table: 'historical_events',
    storage: 'PostgreSQL — historical_events',
    retentionDays: null,
    ageColumn: 'created_at',
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — superseded by contract_events, which the replay path still needs',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1000000000000_initial_schema.ts',
    rationale:
      'Chain-history source rows copied in before replay. Every column is public ledger data ' +
      'and every row is superseded by contract_events, so it is kept indefinitely; the ' +
      'pre-creation and partitioning jobs do not manage it.',
  },
  {
    id: 'contract-event-dedup',
    dataClass: 'Contract event dedup ledger',
    table: 'contract_event_dedup',
    storage: 'PostgreSQL — contract_event_dedup',
    retentionDays: null,
    ageColumn: 'happened_at',
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — expiry is what would re-admit duplicate events, so keys outlive every replay window',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/20260827000000_add_contract_event_dedup.ts',
    rationale:
      'Idempotency keys for the ingest path. Entries must outlive every replay window that ' +
      'could re-present the same event, so expiring them would re-admit duplicates into ' +
      'contract_events. Indefinite, and the table is bounded by the number of distinct ' +
      'events rather than by traffic.',
  },

  // ── Replay state ───────────────────────────────────────────────────────────
  {
    id: 'replay-cursors',
    dataClass: 'Replay cursors',
    table: 'replay_cursors',
    storage: 'PostgreSQL — replay_cursors',
    retentionDays: null,
    ageColumn: 'started_at',
    purgeAction: 'none',
    enforcement: 'operator',
    enforcementRef: 'POST /api/admin/replay — supersedes the cursor for a contract',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1000000000002_create_replay_cursors.ts',
    rationale:
      'Current ingest position, one row per replayed contract. It is live state, not history: ' +
      'restarting a replay supersedes it. A stale row left behind by an abandoned replay is ' +
      'operational noise rather than personal data, so no time-based cut-off is declared.',
  },
  {
    id: 'indexer-replay-progress',
    dataClass: 'Indexer replay progress',
    table: 'indexer_replay_progress',
    storage: 'PostgreSQL — indexer_replay_progress',
    retentionDays: null,
    ageColumn: 'started_at',
    purgeAction: 'none',
    enforcement: 'operator',
    enforcementRef: 'ON DELETE CASCADE from replay_cursors',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/20260624000000_create_indexer_replay_progress.ts',
    rationale:
      'Progress counters for an in-flight replay, with a foreign key onto replay_cursors ' +
      'declared ON DELETE CASCADE. Lifetime is bounded by the owning cursor rather than by a ' +
      'schedule, so the retention period is the cursor’s: indefinite.',
  },

  // ── Audit and compliance ───────────────────────────────────────────────────
  {
    id: 'audit-logs',
    dataClass: 'Audit log',
    table: 'audit_logs',
    storage: 'PostgreSQL — audit_logs',
    retentionDays: 365,
    ageColumn: 'timestamp',
    purgeAction: 'delete',
    enforcement: 'retention-purge',
    enforcementRef: 'src/jobs/retentionPurge.ts — delete rule "Audit logs"',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1774715200000_audit-and-webhook-outbox.ts',
    rationale:
      'One year, per the storage-limitation principle in GDPR Art. 5(1)(e) and the SOC-2 ' +
      'evidence window. The table is append-only at the storage layer, so this is the only ' +
      'delete path into it and it runs under the dedicated retention role (or the ' +
      'transaction-local bypass in single-role deployments). No PII is stored in the rows.',
  },

  // ── Webhooks ───────────────────────────────────────────────────────────────
  {
    id: 'webhook-outbox',
    dataClass: 'Webhook outbox (stream-event fanout)',
    table: 'webhook_outbox',
    storage: 'PostgreSQL — webhook_outbox',
    retentionDays: 90,
    ageColumn: 'created_at',
    purgeAction: 'delete',
    enforcement: 'retention-purge',
    enforcementRef: 'src/jobs/retentionPurge.ts — delete rule "Webhook outbox (processed)"',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1774715200000_audit-and-webhook-outbox.ts',
    rationale:
      'Processed outbox rows exist only for debugging and replay investigation; 90 days is ' +
      'comfortably longer than any incident review and stops the table growing without bound. ' +
      'The cut-off is applied to the row’s age, so a row that is still being retried is ' +
      'removed once it is 90 days old regardless of processed state.',
  },
  {
    id: 'webhook-dlq',
    dataClass: 'Webhook delivery dead-letter queue',
    table: 'webhook_dlq',
    storage: 'PostgreSQL — webhook_dlq',
    retentionDays: 90,
    ageColumn: 'created_at',
    purgeAction: 'delete',
    enforcement: 'retention-purge',
    enforcementRef: 'src/jobs/retentionPurge.ts — delete rule "Webhook DLQ"',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1785082434167_webhook-delivery-store-tables.ts',
    rationale:
      'Every row is a delivery that already exhausted its retries and can no longer ' +
      'succeed, so 90 days is a debug-and-escalate window rather than a delivery SLA. It ' +
      'holds the last copy of a failed payload, which is why the window is generous rather ' +
      'than matching the 30-day job DLQ.',
  },
  {
    id: 'webhook-outbox-items',
    dataClass: 'Webhook delivery queue (management /queue)',
    table: 'webhook_outbox_items',
    storage: 'PostgreSQL — webhook_outbox_items',
    retentionDays: 90,
    ageColumn: 'created_at',
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — a status-scoped purge is required; see unenforcedReason',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1785082434167_webhook-delivery-store-tables.ts',
    unenforcedReason:
      'This is a live work queue, not a log. Rows in status pending or in_flight have not ' +
      'been delivered yet, and the generic purge job selects purely on age — pointing it at ' +
      'this table would silently drop undelivered webhooks. The period below is the ' +
      'commitment for terminal rows; enforcement needs a status-scoped predicate (compare ' +
      'dead_letter_queue, whose purge filters on status) and is tracked as a follow-up to ' +
      'issue #1506. Terminal rows are meanwhile bounded in practice by ' +
      'max_attempts and by operators draining the queue.',
    rationale:
      'Delivery attempts for the management API. An item is retried up to max_attempts ' +
      '(default 5) and then moved to webhook_dlq, so an item that survives 90 days is one ' +
      'that has exhausted its budget and will never be delivered.',
  },
  {
    id: 'webhook-deliveries',
    dataClass: 'Webhook delivery status records',
    table: 'webhook_deliveries',
    storage: 'PostgreSQL — webhook_deliveries',
    retentionDays: 90,
    ageColumn: 'created_at',
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — a status-scoped purge is required; see unenforcedReason',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1785082434167_webhook-delivery-store-tables.ts',
    unenforcedReason:
      'Shares the reason above: status defaults to pending, so an age-only predicate would ' +
      'delete deliveries that were never attempted. A status-scoped purge is a follow-up to ' +
      'issue #1506. Until then the table is bounded by the delivery volume of the ' +
      'management API.',
    rationale:
      'Per-delivery attempt history backing the /queue and retry routes. Once a delivery is ' +
      'terminal, 90 days matches the webhook-dlq window so both sides of a failure can be ' +
      'investigated together.',
  },
  {
    id: 'webhook-secrets',
    dataClass: 'Webhook signing secrets',
    table: null,
    storage: 'operator secret store (environment / secret manager)',
    retentionDays: null,
    purgeAction: 'none',
    enforcement: 'external',
    enforcementRef: 'operator secret store — this service neither creates nor owns the value',
    legalHoldExempt: false,
    classification: DataClassification.RESTRICTED,
    rationale:
      'Webhook signing secrets are configured out of band and are never written to any table ' +
      'this service owns; the code reads them from the environment / secret manager. Listed ' +
      'so the schedule is complete, and so nobody assumes the service can revoke one. ' +
      'Revocation is a deployment concern and is not subject to this schedule.',
  },

  // ── Job queues ─────────────────────────────────────────────────────────────
  {
    id: 'dead-letter-queue',
    dataClass: 'Job dead-letter queue',
    table: 'dead_letter_queue',
    storage: 'PostgreSQL — dead_letter_queue',
    retentionDays: 30,
    ageColumn: 'last_failed_at',
    purgeAction: 'delete',
    enforcement: 'dlq-purge',
    enforcementRef: 'src/jobs/dlqPurge.ts — DLQ_RETENTION_DAYS (default 30)',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1774715300000_dead-letter-queue.ts',
    rationale:
      'A message that has already failed sits in the DLQ until an operator replays or ' +
      'discards it. 30 days is the window in which a failure is still actionable, after ' +
      'which the row is noise. The window is operator-configurable per deployment via ' +
      'DLQ_RETENTION_DAYS (1–365, 0 disables the purge) and capped at 365 days so a typo ' +
      'cannot delete all history. Only terminal-state entries are eligible; a recently ' +
      'failed entry is never touched.',
  },
  {
    id: 'dlq-consumer-suspension',
    dataClass: 'DLQ consumer suspension state',
    table: 'dlq_consumer_suspension',
    storage: 'PostgreSQL — dlq_consumer_suspension',
    retentionDays: null,
    ageColumn: 'updated_at',
    purgeAction: 'none',
    enforcement: 'operator',
    enforcementRef: 'POST /api/admin/dlq/consumers/:topic/resume (src/routes/admin.ts)',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/1750000000000_dlq_consumer_suspension.ts',
    rationale:
      'One row per consumer topic holding live suspension state. An unrevoked suspension is ' +
      'itself the protection, so it must not expire on a timer: the counter is what stops a ' +
      'poison consumer from being retried forever. Clearing it is an explicit, audited ' +
      'operator resume, and the table is bounded by the number of topics.',
  },
  {
    id: 'job-dead-letter',
    dataClass: 'Job dead-letter table',
    table: 'job_dead_letter',
    storage: 'PostgreSQL — job_dead_letter',
    retentionDays: 90,
    ageColumn: 'failed_at',
    purgeAction: 'delete',
    enforcement: 'retention-purge',
    enforcementRef: 'src/jobs/retentionPurge.ts — delete rule "Job dead-letter table"',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/20260727000000_job_dead_letter.ts',
    rationale:
      'Rows only arrive here after every retry has been exhausted, so nothing here is ' +
      'recoverable work. 90 days matches the webhook DLQ so a single incident window can be ' +
      'reconstructed across both queues, and keeps the table from growing without bound as ' +
      'failing jobs accumulate.',
  },

  // ── Configuration ──────────────────────────────────────────────────────────
  {
    id: 'tenant-rate-limit-overrides',
    dataClass: 'Tenant rate-limit overrides',
    table: 'tenant_rate_limit_overrides',
    storage: 'PostgreSQL — tenant_rate_limit_overrides',
    retentionDays: 0,
    ageColumn: 'expires_at',
    purgeAction: 'expire',
    enforcement: 'retention-purge',
    enforcementRef:
      'src/jobs/retentionPurge.ts — delete rule "Tenant rate-limit overrides"; the row also self-expires at expires_at',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    migration: 'migrations/20260728000000_tenant_rate_limit_overrides.ts',
    rationale:
      'An override stops applying the instant its own expires_at passes, so the residual row ' +
      'has no operational value: retentionDays 0 makes the cut-off `now` and the row is ' +
      'deleted as soon as it has expired. Live overrides are never touched, because their ' +
      'expires_at is in the future.',
  },

  // ── Outside the database ───────────────────────────────────────────────────
  {
    id: 'idempotency-keys',
    dataClass: 'Idempotency keys',
    table: null,
    storage: 'Redis (or process memory) — idempotency store',
    retentionDays: 1,
    purgeAction: 'expire',
    enforcement: 'ttl',
    enforcementRef: 'IDEMPOTENCY_TTL_SECONDS (default 86400 = 24 h) via src/middleware/idempotency.ts',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    rationale:
      'Replay protection for POST /api/streams. A key only has to outlive the client’s retry ' +
      'window, which the idempotency contract caps at 7 days and defaults to 24 hours. The ' +
      'store sets its own TTL, so there is no purge job to schedule. A key can be correlated ' +
      'to a specific request, so it is written with a redacting logger.',
  },
  {
    id: 'application-logs',
    dataClass: 'Application logs',
    table: null,
    storage: 'stdout → operator log aggregator',
    retentionDays: 30,
    purgeAction: 'none',
    enforcement: 'external',
    enforcementRef: 'aggregator retention policy; PII redacted at emission by src/pii/sanitizer.ts',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    rationale:
      '30 days of operational diagnostics. The service redacts classified fields before ' +
      'emission (DataClassification.RESTRICTED is never persisted), so a log line carries no ' +
      'credential or raw key; the aggregator’s own retention is what enforces the window and ' +
      'is configured outside this repository.',
  },
  {
    id: 'request-metadata',
    dataClass: 'HTTP request metadata (IP, user-agent)',
    table: null,
    storage: 'process memory (per request)',
    retentionDays: 0,
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — never written to a persistent store, so there is nothing to purge',
    legalHoldExempt: false,
    classification: DataClassification.RESTRICTED,
    rationale:
      'Read for the lifetime of the request — rate limiting and IP extraction — and never ' +
      'written to any persistent store. Zero days means the data ceases to exist when the ' +
      'request completes, so no purge mechanism is needed or possible.',
  },
  {
    id: 'auth-tokens',
    dataClass: 'Authentication tokens and credentials',
    table: null,
    storage: 'process memory (per request)',
    retentionDays: 0,
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef:
      'none — validated in flight and never written to a persistent store',
    legalHoldExempt: false,
    classification: DataClassification.RESTRICTED,
    rationale:
      'Bearer tokens and API keys are validated in flight and are neither persisted nor ' +
      'logged. api_keys stores only a keyed hash, never the token. Zero days, same as ' +
      'request metadata.',
  },
  {
    id: 'database-backups',
    dataClass: 'Database backups',
    table: null,
    storage: 'S3 (operator-managed) — src/scripts/backup-retention.ts',
    retentionDays: 365,
    purgeAction: 'delete',
    enforcement: 'external',
    enforcementRef: 'src/scripts/backup-retention.ts — DEFAULT_POLICY (daily 7 d, weekly 28 d, monthly 365 d)',
    legalHoldExempt: false,
    classification: DataClassification.RESTRICTED,
    rationale:
      'A three-tier policy: 7 days of daily snapshots, 28 days of weekly, 365 days of ' +
      'monthly. The longest tier is the binding number for this schedule, and it is the one ' +
      'that matters for a subject-access response: a subject’s data can still exist inside a ' +
      'monthly backup for up to a year after it was purged from the live database. Backups ' +
      'are encrypted, access-controlled, and restored into an isolated environment, so the ' +
      'purge job does not touch them.',
  },
];

// ── Derived: the rule list the purge job actually runs ────────────────────────

/**
 * Rules the automated retention purge job can enforce, derived from
 * {@link RETENTION_MANIFEST}.
 *
 * Deriving rather than hand-maintaining this list is what makes
 * "the published schedule matches the implementation" a structural property
 * instead of a review convention: an entry with `enforcement:
 * 'retention-purge'` is, by construction, in the list the job iterates, with
 * the same `retentionDays`, table, age column and purge action.
 *
 * Only `retention-purge` entries appear — `dlq-purge` has its own job
 * (`src/jobs/dlqPurge.ts`) because it filters on terminal status rather than
 * age alone, and the other mechanisms do not delete rows at all.
 *
 * Order is the manifest's order, which is grouped by data class. The job
 * evaluates rules sequentially, so this is also the order in which tables are
 * purged.
 */
export const PURGEABLE_RETENTION_SCHEDULE: PurgeableRetentionRule[] = RETENTION_MANIFEST.filter(
  (rule): rule is DataRetentionRule & { table: string; ageColumn: string } =>
    rule.enforcement === 'retention-purge' && rule.table !== null && rule.ageColumn !== undefined,
).map((rule) => ({
  category: rule.dataClass,
  retentionDays: rule.retentionDays as number,
  storageLayer: rule.storage,
  rationale: rule.rationale,
  table: rule.table,
  ageColumn: rule.ageColumn,
  // `expire` is how the *policy* describes the outcome — the row has already
  // lapsed by its own expires_at — while the job's only mechanism for getting
  // rid of a row is a DELETE. Mapping it here (rather than casting) keeps the
  // job's `purgeRow` from ever seeing a third verb it has no branch for.
  purgeAction: rule.purgeAction === 'redact' ? 'redact' : 'delete',
}));

/**
 * Default `DLQ_RETENTION_DAYS` recorded in the manifest, asserted against the
 * shipped env schema by `scripts/check-retention-schedule.ts`. The window is
 * operator-tunable, so the manifest tracks the default rather than freezing a
 * number the deployment can legitimately change.
 */
export const DLQ_RETENTION_DAYS_DEFAULT = 30;

/**
 * Default `IDEMPOTENCY_TTL_SECONDS` in days, for the same reason: the
 * idempotency window is configurable and only the default is a commitment.
 */
export const IDEMPOTENCY_TTL_DAYS_DEFAULT = 1;

// ── Derived: the public projection ────────────────────────────────────────────

/**
 * A single manifest entry in the shape the public privacy endpoints publish.
 *
 * Field names mirror the historical `RETENTION_SCHEDULE` entries so existing
 * consumers of `/api/privacy/retention` keep working; the additional fields
 * are additive.
 */
export interface PublishedRetentionRule {
  category: string;
  retentionDays: number | null;
  storageLayer: string;
  rationale: string;
  /** Stable id from the manifest, for cross-referencing the document. */
  id: string;
  /** PostgreSQL table, or `null` for non-database data. */
  table: string | null;
  /** How the period is enforced. */
  enforcement: RetentionEnforcement;
  /** What deletes or redacts an expired row. */
  purgeAction: PurgeAction;
  /** Whether a legal hold can suspend deletion of this class. */
  legalHoldExempt: boolean;
  /** Highest classification present in the class. */
  classification: DataClassification;
  /** Present only when a finite period is declared with no enforcement. */
  unenforcedReason?: string;
}

/** Project the manifest into the public, documented shape. */
export function publishedRetentionRules(): PublishedRetentionRule[] {
  return RETENTION_MANIFEST.map((rule) => {
    const published: PublishedRetentionRule = {
      category: rule.dataClass,
      retentionDays: rule.retentionDays,
      storageLayer: rule.storage,
      rationale: rule.rationale,
      id: rule.id,
      table: rule.table,
      enforcement: rule.enforcement,
      purgeAction: rule.purgeAction,
      legalHoldExempt: rule.legalHoldExempt,
      classification: rule.classification,
    };
    if (rule.unenforcedReason) published.unenforcedReason = rule.unenforcedReason;
    return published;
  });
}
