/**
 * Audit log for sensitive actions.
 *
 * Records immutable entries whenever a privileged state-changing operation
 * occurs (stream create, stream cancel). Entries are append-only; nothing
 * in this module mutates or removes existing records.
 *
 * Trust boundaries
 * - Internal workers call `recordAuditEvent` directly.
 * - Administrators may query entries via GET /api/audit.
 * - Public clients and authenticated partners have no access to this log.
 *
 * Failure modes
 * - Recording never throws; a failed write is logged to stderr and silently
 *   dropped so the primary operation is never blocked by audit infrastructure.
 *
 * Non-goals (follow-up)
 * - Persistent storage (PostgreSQL audit table).
 * - Pagination / filtering beyond what is provided here.
 * - Tamper-evidence / cryptographic chaining.
 */

import { logger } from './logger.js';

export type AuditAction = 'STREAM_CREATED' | 'STREAM_CANCELLED';

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

/**
 * Append an audit entry. Never throws.
 */
export function recordAuditEvent(
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  correlationId?: string,
  meta?: Record<string, unknown>
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

/** Return a shallow copy of all entries (oldest first). */
export function getAuditEntries(): AuditEntry[] {
  return [...((globalThis as any)[AUDIT_LOG_KEY] || [])];
}

/** Reset store — test use only. */
export function _resetAuditLog(): void {
  (globalThis as any)[AUDIT_LOG_KEY] = [];
  seq = 0;
}
