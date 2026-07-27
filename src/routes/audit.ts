/**
 * GET /api/audit
 *
 * Returns the in-process audit log. Intended for administrators only.
 * Public clients and authenticated partners must not be granted access to
 * this route (enforce at the gateway / auth middleware layer).
 *
 * Query parameters:
 *   @param limit      - Number of entries to return. Must be 1–100. Defaults to 20.
 *                       Returns 400 if out of range.
 *   @param offset     - Zero-based offset into the audit log. Must be >= 0. Defaults to 0.
 *                       Returns 400 if negative.
 *   @param actor      - Filter by actor. Matches against `entry.meta.actor` or `entry.actor`.
 *   @param actionType - Filter by action type (e.g. STREAM_CREATED, PAUSE_FLAGS_UPDATED).
 *   @param dateFrom   - ISO-8601 timestamp. Only include entries at or after this time.
 *   @param dateTo     - ISO-8601 timestamp. Only include entries at or before this time.
 *
 * Response shape:
 *   { success: true, data: { entries: AuditEntry[], total: number }, meta: ResponseMeta }
 *
 * Failure modes:
 *   - No entries yet → 200 with empty array (not 404).
 *   - limit out of range → 400 VALIDATION_ERROR
 *   - offset < 0 → 400 VALIDATION_ERROR
 *
 * Security notes:
 *   - The `details`/`meta` fields of audit entries are redacted of any RESTRICTED
 *     field names (authToken, authorization, x-api-key) before being returned.
 *     This prevents accidental exposure of credentials in audit records.
 */

import { z } from 'zod';
import { Router } from 'express';
import { getAuditEntries, type AuditEntry } from '../lib/auditLog.js';
import { successResponse } from '../utils/response.js';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { ApiError } from '../errors.js';
import { ApiErrorCode } from '../middleware/errorHandler.js';
import { OffsetPaginationSchema, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT } from '../validation/paginationSchema.js';

export const auditRouter = Router();

/** Field names that must never appear in audit log responses. */
const RESTRICTED_FIELDS = new Set(['authtoken', 'authorization', 'x-api-key']);

/**
 * Recursively redact RESTRICTED field names from an object.
 * Matching keys are replaced with `"[REDACTED]"`.
 */
function redactRestricted(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactRestricted);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = RESTRICTED_FIELDS.has(k.toLowerCase()) ? '[REDACTED]' : redactRestricted(v);
  }
  return result;
}

/**
 * Redact sensitive fields from a single audit entry's `meta` blob.
 */
function sanitizeEntry(entry: AuditEntry): AuditEntry {
  if (!entry.meta) return entry;
  return { ...entry, meta: redactRestricted(entry.meta) as Record<string, unknown> };
}

/** Extended schema that adds filter params on top of offset pagination. */
const AuditQuerySchema = OffsetPaginationSchema.extend({
  actor: z.string().optional(),
  actionType: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

auditRouter.get('/', authenticate, requireAuth, requirePermission(Permission.AUDIT_READ), (req, res, next) => {
  try {
    const requestId = req.correlationId;

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, firstIssue?.message ?? 'Invalid query parameters', true);
    }

    const { limit, offset, actor, actionType, dateFrom, dateTo } = parsed.data;
    const limitNum = limit ?? DEFAULT_PAGE_LIMIT;
    const offsetNum = offset ?? 0;

    let filteredEntries = getAuditEntries();

    if (actor !== undefined) {
      filteredEntries = filteredEntries.filter(
        (e) => e.meta?.actor === actor || (e as AuditEntry & { actor?: string }).actor === actor,
      );
    }

    if (actionType !== undefined) {
      filteredEntries = filteredEntries.filter((e) => e.action === actionType);
    }

    if (dateFrom !== undefined) {
      filteredEntries = filteredEntries.filter((e) => e.timestamp >= dateFrom);
    }

    if (dateTo !== undefined) {
      filteredEntries = filteredEntries.filter((e) => e.timestamp <= dateTo);
    }

    const page = filteredEntries.slice(offsetNum, offsetNum + limitNum).map(sanitizeEntry);

    res.json(successResponse({ entries: page, total: filteredEntries.length }, requestId));
  } catch (err) {
    next(err);
  }
});
