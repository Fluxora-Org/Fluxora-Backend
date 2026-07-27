/**
 * PII policy definitions for the Fluxora backend.
 *
 * This module is the single source of truth for data classification,
 * retention periods, and field-level sensitivity across the service.
 * All other modules that handle potentially sensitive data must
 * reference these definitions rather than hard-coding their own rules.
 */

export enum DataClassification {
  /** Freely shareable (health status, API version, docs links). */
  PUBLIC = 'PUBLIC',
  /** Operational data visible to authenticated partners and operators. */
  INTERNAL = 'INTERNAL',
  /** Pseudonymous identifiers that could be correlated to real identities. */
  SENSITIVE = 'SENSITIVE',
  /** Credentials, tokens, or direct PII — never persisted in logs. */
  RESTRICTED = 'RESTRICTED',
}

export interface FieldPolicy {
  classification: DataClassification;
  /** Whether this field must be redacted before it leaves the process in logs or error payloads. */
  redactInLogs: boolean;
  /** Human-readable rationale for the classification. */
  rationale: string;
}

export interface RetentionRule {
  /** Category label shown in the privacy endpoint. */
  category: string;
  /** Maximum number of days data in this category is retained. null = indefinite (chain-derived). */
  retentionDays: number | null;
  /** Where the data lives (memory, database, external chain). */
  storageLayer: string;
  /** Justification for the retention window. */
  rationale: string;
}

/**
 * Extension of `RetentionRule` for categories that can be actively purged
 * by the scheduled retention-purge job.
 *
 * The extra fields tell the job:
 *  - which database table to target (`table`)
 *  - which column records the row's age (`ageColumn`) — the job compares
 *    this against `NOW() - INTERVAL '<retentionDays> days'`
 *  - how to purge rows whose retention window has expired (`purgeAction`):
 *      `delete`  — hard-delete the row entirely (use for ephemeral metadata).
 *      `redact`  — overwrite PII columns with a placeholder and set
 *                  `purged_at` (use when the row must stay for audit integrity
 *                   but its sensitive fields must not persist).
 */
export interface PurgeableRetentionRule extends RetentionRule {
  /**
   * The fully-qualified table name the purge job will operate on.
   * Must reference a table that has a `legal_hold` boolean column.
   */
  table: string;
  /**
   * Column used to determine the age of a row for the retention cut-off
   * calculation. Typically `created_at`.
   */
  ageColumn: string;
  /**
   * Purge strategy:
   *  - `delete`  — remove rows past their retention window.
   *  - `redact`  — blank PII fields and stamp `purged_at`; the row shell
   *                remains for referential integrity.
   */
  purgeAction: 'delete' | 'redact';
}

/**
 * Field-level classification for stream records.
 *
 * Stellar public keys are pseudonymous — they do not directly identify
 * a person — but they can be correlated with exchange KYC records or
 * on-chain activity, so we treat them as SENSITIVE.
 */
export const STREAM_FIELD_POLICIES: Record<string, FieldPolicy> = {
  id: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'System-generated identifier with no off-chain meaning.',
  },
  sender: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Stellar public key — pseudonymous but correlatable.',
  },
  recipient: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Stellar public key — pseudonymous but correlatable.',
  },
  depositAmount: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'On-chain amount; publicly observable via Horizon.',
  },
  ratePerSecond: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'Derived from on-chain contract state.',
  },
  startTime: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Unix timestamp; publicly observable.',
  },
  status: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Stream lifecycle state; no privacy implications.',
  },
};

/**
 * Request metadata fields that may arrive in HTTP headers or be
 * inferred from the connection. Kept separate from domain fields.
 */
export const REQUEST_FIELD_POLICIES: Record<string, FieldPolicy> = {
  ipAddress: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Client IP can identify individuals; never persisted.',
  },
  userAgent: {
    classification: DataClassification.INTERNAL,
    redactInLogs: true,
    rationale: 'Browser fingerprint fragment; redact from logs.',
  },
  authToken: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Bearer token — must never appear in any log output.',
  },
  authorization: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Authorization header containing credentials or tokens.',
  },
  'x-api-key': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'API key used for authentication.',
  },
  'idempotency-key': {
    classification: DataClassification.INTERNAL,
    redactInLogs: true,
    rationale: 'Idempotency key could be correlated to specific requests.',
  },
  password: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Password or credential in request body.',
  },
  secret: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Secret value in request body or response.',
  },
  token: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Token value in request body or response.',
  },
  credential: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Credential value in request body or response.',
  },
  key: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Key value that could be sensitive.',
  },
  'private-key': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Private key material.',
  },
  'api-key': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'API key value.',
  },
  'access-token': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Access token value.',
  },
  'refresh-token': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Refresh token value.',
  },
  'session-id': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Session identifier.',
  },
  cookie: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Cookie value containing session or authentication data.',
  },
  'set-cookie': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Set-Cookie header containing session data.',
  },
};

/** Retention schedule exposed via the privacy endpoint. */
export const RETENTION_SCHEDULE: RetentionRule[] = [
  {
    category: 'Stream records (chain-derived)',
    retentionDays: null,
    storageLayer: 'in-memory (future: PostgreSQL)',
    rationale:
      'Mirrors immutable on-chain state. Retained as long as the contract exists; deletion would create inconsistency with Horizon.',
  },
  {
    category: 'Stream address PII',
    retentionDays: 365,
    storageLayer: 'PostgreSQL — streams',
    rationale:
      'Sender and recipient addresses are sensitive pseudonymous identifiers. After 365 days these fields are redacted in place unless the stream is under legal hold.',
  },
  {
    category: 'HTTP request metadata',
    retentionDays: 0,
    storageLayer: 'ephemeral (process memory)',
    rationale:
      'IP addresses and headers are used only for the lifetime of the request and are not written to any persistent store.',
  },
  {
    category: 'Application logs',
    retentionDays: 30,
    storageLayer: 'stdout / log aggregator',
    rationale:
      'Structured logs are retained for operational diagnostics. PII fields are redacted before emission.',
  },
  {
    category: 'Authentication tokens',
    retentionDays: 0,
    storageLayer: 'ephemeral (process memory)',
    rationale: 'Tokens are validated in-flight and never persisted or logged.',
  },
];

/**
 * Subset of the retention schedule that the automated purge job can
 * enforce.  Each entry extends `RetentionRule` with the database
 * coordinates and purge strategy needed to actually delete or redact
 * expired rows.
 *
 * Rules are evaluated in order during each purge run.  Add a new entry
 * here whenever a table gains a `created_at` column and reaches a finite
 * retention commitment.
 *
 * Legal-hold exemption applies globally: any row in the target table
 * with `legal_hold = TRUE` is skipped by the purge job and a
 * `PURGE_SKIPPED_LEGAL_HOLD` audit event is written instead.
 */
export const PURGEABLE_RETENTION_SCHEDULE: PurgeableRetentionRule[] = [
  {
    category: 'Audit logs',
    retentionDays: 365,
    storageLayer: 'PostgreSQL — audit_logs',
    rationale:
      'Audit records are kept for one year for regulatory compliance (SOC-2, GDPR Art. 5(1)(e)).' +
      ' After 365 days the row is hard-deleted; no PII is stored in the audit log itself.',
    table: 'audit_logs',
    ageColumn: 'timestamp',
    purgeAction: 'delete',
  },
  {
    category: 'Stream address PII',
    retentionDays: 365,
    storageLayer: 'PostgreSQL — streams',
    rationale:
      'Sender and recipient addresses are sensitive pseudonymous identifiers. After 365 days these fields are redacted in place unless the stream is under legal hold.',
    table: 'streams',
    ageColumn: 'created_at',
    purgeAction: 'redact',
  },
  {
    category: 'Webhook outbox (processed)',
    retentionDays: 90,
    storageLayer: 'PostgreSQL — webhook_outbox',
    rationale:
      'Processed outbox rows are retained for 90 days for debugging and replay investigation,' +
      ' then purged to prevent unbounded table growth.',
    table: 'webhook_outbox',
    ageColumn: 'created_at',
    purgeAction: 'delete',
  },
];

/**
 * Trust boundary definitions describing what each actor class
 * may and may not do. Consumed by the privacy endpoint and
 * referenced in authorization middleware (future).
 */
export interface TrustBoundary {
  actor: string;
  description: string;
  allowed: string[];
  denied: string[];
}

export const TRUST_BOUNDARIES: TrustBoundary[] = [
  {
    actor: 'Anonymous client',
    description: 'Unauthenticated public internet request.',
    allowed: [
      'Read public stream list and individual stream details',
      'Read health and API info endpoints',
      'Read privacy policy endpoint',
    ],
    denied: [
      'Create or mutate stream records (future: requires auth)',
      'Access admin or operator endpoints',
      'View raw logs or internal diagnostics',
    ],
  },
  {
    actor: 'Authenticated partner',
    description: 'Client presenting a valid API key or JWT.',
    allowed: [
      'All anonymous client permissions',
      'Create stream records',
      'Read own stream history',
    ],
    denied: [
      'Access admin endpoints',
      "View other partners' stream data (future: row-level isolation)",
      'View raw logs or internal diagnostics',
    ],
  },
  {
    actor: 'Administrator',
    description: 'Operator with elevated credentials.',
    allowed: [
      'All partner permissions',
      'View aggregated metrics and health details',
      'Trigger manual data reconciliation',
    ],
    denied: ['Bypass PII redaction in API responses', 'Export raw PII without audit trail'],
  },
  {
    actor: 'Internal worker',
    description: 'Background process (Horizon listener, cron jobs).',
    allowed: [
      'Write chain-derived stream records',
      'Update stream status from contract events',
      'Emit structured log events',
    ],
    denied: [
      'Serve HTTP responses directly',
      'Access authentication tokens or session state',
      'Log raw Stellar keys without redaction',
    ],
  },
];

/**
 * Returns the set of field names that must be redacted before logging,
 * combining both stream and request policies.
 * Returns field names in lowercase for case-insensitive matching.
 */
export function redactableFields(): Set<string> {
  const fields = new Set<string>();
  for (const [name, policy] of Object.entries(STREAM_FIELD_POLICIES)) {
    if (policy.redactInLogs) fields.add(name.toLowerCase());
  }
  for (const [name, policy] of Object.entries(REQUEST_FIELD_POLICIES)) {
    if (policy.redactInLogs) fields.add(name.toLowerCase());
  }
  return fields;
}
