/**
 * Audit log for sensitive actions.
 *
 * Records immutable entries whenever a privileged state-changing operation
 * occurs (stream create, stream cancel). Entries are append-only; nothing
 * in this module mutates or removes existing records.
 *
 * Two write paths:
 *  1. `recordAuditEvent`          – in-memory only; never throws; used by
 *                                   non-transactional callers (admin routes, etc.)
 *  2. `buildAuditEntry` +
 *     `writeAuditEntryToDb`       – used inside DB transactions so the audit
 *                                   row is committed or rolled back atomically
 *                                   with the primary stream operation.
 *
 * Trust boundaries
 * - Internal workers call `recordAuditEvent` or the transactional helpers.
 * - Administrators may query entries via GET /api/audit.
 * - Public clients and authenticated partners have no access to this log.
 *
 * Failure modes
 * - `recordAuditEvent` never throws; a failed write is logged to stderr.
 * - `writeAuditEntryToDb` throws on DB error so the caller's transaction
 *   rolls back atomically.
 */

import { logger } from './logger.js';

export type AuditAction = 'STREAM_CREATED' | 'STREAM_CANCELLED' | 'STREAM_STATUS_UPDATED' | 'DLQ_LISTED' | 'DLQ_REPLAYED' | 'DLQ_PURGED' | 'PAUSE_FLAGS_UPDATED' | 'REINDEX_TRIGGERED';

export interface AuditEntry {
  /** Monotonically increasing sequence number within this process lifetime. */
  seq: number;
  /** ISO-8601 timestamp at the moment the event was recorded. */
  timestamp: string;
  action: AuditAction;
  /** Resource type affected, e.g. "stream". */
  resourceType: string;
  /** Identifier of the affected resource. */
  resourceId: string;
  /** Correlation ID from the originating HTTP request, if available. */
  correlationId?: string;
  /** Arbitrary additional context (amounts, addresses, etc.). */
  meta?: Record<string, unknown>;
}

let seq = 0;
const AUDIT_LOG_KEY = '__FLUXORA_AUDIT_LOG__';
if (!(globalThis as any)[AUDIT_LOG_KEY]) {
  (globalThis as any)[AUDIT_LOG_KEY] = [];
}
const auditLog: AuditEntry[] = (globalThis as any)[AUDIT_LOG_KEY];

// ── In-memory path (non-transactional) ───────────────────────────────────────

/**
 * Append an audit entry to the in-memory log. Never throws.
 * Use this for non-transactional callers (admin routes, etc.).
 */
export function recordAuditEvent(
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  correlationId?: string,
  meta?: Record<string, unknown>,
): void {
  try {
    const entry: AuditEntry = {
      seq: ++seq,
      timestamp: new Date().toISOString(),
      action,
      resourceType,
      resourceId,
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
    auditLog.push(entry);
    logger.info('Audit event recorded', correlationId, { action, resourceType, resourceId });
  } catch (err) {
    // Audit must never block the primary operation.
    logger.error('Failed to record audit event', undefined, {
      action,
      resourceType,
      resourceId,
      err: String(err),
    });
  }
}

// ── Transactional path (DB-backed) ───────────────────────────────────────────

/**
 * Build an AuditEntry without writing it anywhere.
 * Pass the result to `writeAuditEntryToDb` inside an open DB transaction.
 */
export function buildAuditEntry(
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  correlationId?: string,
  meta?: Record<string, unknown>,
): AuditEntry {
  return {
    seq: ++seq,
    timestamp: new Date().toISOString(),
    action,
    resourceType,
    resourceId,
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * Write a pre-built AuditEntry to the `audit_logs` table using the supplied
 * DB connection (which must already be inside a transaction).
 *
 * Throws on DB error so the caller's transaction rolls back atomically.
 * Also mirrors the entry into the in-memory log for GET /api/audit.
 */
export function writeAuditEntryToDb(db: AuditDbConnection, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_logs
       (seq, timestamp, action, resource_type, resource_id, correlation_id, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.seq,
    entry.timestamp,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    entry.correlationId ?? null,
    entry.meta !== undefined ? JSON.stringify(entry.meta) : null,
  );

  // Mirror into in-memory log so GET /api/audit reflects transactional writes.
  auditLog.push(entry);
  logger.info('Audit entry written to DB', entry.correlationId, {
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
  });
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Return a shallow copy of all in-memory entries (oldest first). */
export function getAuditEntries(): AuditEntry[] {
  return [...((globalThis as any)[AUDIT_LOG_KEY] || [])];
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Reset store — test use only. */
export function _resetAuditLog(): void {
  const log = (globalThis as any)[AUDIT_LOG_KEY];
  if (Array.isArray(log)) {
    log.length = 0;
  }
  seq = 0;
}
