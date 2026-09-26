/**
 * PII policy definitions for the Fluxora backend.
 *
 * This module holds the field-level classification policy and the trust
 * boundaries. The **retention** schedule lives in `src/pii/retention.ts` and is
 * re-exported here, because the retention commitments and the purge job that
 * enforces them have to be derived from a single list — see the module docs of
 * `src/pii/retention.ts` and `docs/retention-schedule.md`.
 */

import { DataClassification } from './classification.js';
import { publishedRetentionRules, type RetentionRule } from './retention.js';

export { DataClassification };
export { LEGAL_HOLD_EXEMPT_TABLES, LEGAL_HOLD_POLICY, RETENTION_MANIFEST } from './retention.js';
export type {
  DataRetentionRule,
  PublishedRetentionRule,
  PurgeAction,
  PurgeableRetentionRule,
  RetentionEnforcement,
  RetentionRule,
} from './retention.js';
export { PURGEABLE_RETENTION_SCHEDULE } from './retention.js';

export interface FieldPolicy {
  classification: DataClassification;
  /** Whether this field must be redacted before it leaves the process in logs or error payloads. */
  redactInLogs: boolean;
  /** Human-readable rationale for the classification. */
  rationale: string;
}

export type StreamFieldPolicyKey =
  | keyof import('../db/types.js').StreamRecord
  | 'sender'
  | 'recipient'
  | 'depositAmount'
  | 'ratePerSecond'
  | 'startTime';

export const STREAM_FIELD_POLICIES: Record<StreamFieldPolicyKey, FieldPolicy> = {
  id: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'System-generated identifier with no off-chain meaning.',
  },
  sender_address: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Stellar public key — pseudonymous but correlatable.',
  },
  recipient_address: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Stellar public key — pseudonymous but correlatable.',
  },
  amount: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'On-chain amount; publicly observable via Horizon.',
  },
  streamed_amount: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'On-chain amount; publicly observable via Horizon.',
  },
  remaining_amount: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'On-chain amount; publicly observable via Horizon.',
  },
  rate_per_second: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'Derived from on-chain contract state.',
  },
  start_time: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Unix timestamp; publicly observable.',
  },
  end_time: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Unix timestamp; publicly observable.',
  },
  status: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Stream lifecycle state; no privacy implications.',
  },
  contract_id: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Contract ID.',
  },
  transaction_hash: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Transaction hash.',
  },
  event_index: {
    classification: DataClassification.PUBLIC,
    redactInLogs: false,
    rationale: 'Event index.',
  },
  created_at: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'Internal timestamp.',
  },
  updated_at: {
    classification: DataClassification.INTERNAL,
    redactInLogs: false,
    rationale: 'Internal timestamp.',
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
  address: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Blockchain or physical address that may identify a person.',
  },
  payload: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Webhook or request payload may contain arbitrary user data.',
  },
  body: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Request or response body may contain arbitrary user data.',
  },
  query: {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Raw database queries can contain identifiers or user data.',
  },
  'query-params': {
    classification: DataClassification.RESTRICTED,
    redactInLogs: true,
    rationale: 'Database query parameters may contain identifiers or user data.',
  },
  'database-id': {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Internal database identifiers must not leave the process.',
  },
  'row-id': {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Internal row identifiers can expose database structure.',
  },
  sender: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Stellar address in API requests.',
  },
  recipient: {
    classification: DataClassification.SENSITIVE,
    redactInLogs: true,
    rationale: 'Stellar address in API requests.',
  },
};

/**
 * Retention schedule exposed via the privacy endpoint.
 *
 * A projection of `RETENTION_MANIFEST` in `src/pii/retention.ts` — every class
 * of persisted data the service has, each with its period, the mechanism that
 * enforces it, and whether a legal hold can override it. The projection keeps
 * the historical `category` / `retentionDays` / `storageLayer` / `rationale`
 * field names and adds the enforcement metadata, so existing consumers of
 * `/api/privacy/retention` and `/api/privacy/policy` keep working.
 *
 * The human-readable rendering of the same list, including the legal-hold
 * rules and the exemptions, is `docs/retention-schedule.md`; CI keeps the two
 * in step via `scripts/check-retention-schedule.ts`.
 */
export const RETENTION_SCHEDULE: RetentionRule[] = publishedRetentionRules();

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
