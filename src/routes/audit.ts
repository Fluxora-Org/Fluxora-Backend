/**
 * GET /api/audit
 *
 * Returns the in-process audit log. Intended for administrators only.
 * Public clients and authenticated partners must not be granted access to
 * this route (enforce at the gateway / auth middleware layer).
 *
 * Query parameters:
 *   @param limit  - Number of entries to return. Must be 1–100. Defaults to 20.
 *                   Returns 400 if set to 0, negative, or greater than 100.
 *   @param offset - Zero-based offset into the audit log. Must be >= 0. Defaults to 0.
 *                   Returns 400 if negative.
 *
 * Response shape:
 *   { success: true, data: { entries: AuditEntry[], total: number }, meta: ResponseMeta }
 *
 * Failure modes:
 *   - No entries yet → 200 with empty array (not 404).
 *   - limit=0 → 400 VALIDATION_ERROR
 *   - limit > 100 → 400 VALIDATION_ERROR
 *   - offset < 0 → 400 VALIDATION_ERROR
 *
 * Security notes:
 *   - The `details`/`meta` fields of audit entries are redacted of any RESTRICTED
 *     field names (authToken, authorization, x-api-key) before being returned.
 *     This prevents accidental exposure of credentials in audit records.
 */

import { Router } from 'express';
import { getAuditEntries, type AuditEntry } from '../lib/auditLog.js';
import { successResponse } from '../utils/response.js';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { ApiError } from '../errors.js';
import { ApiErrorCode } from '../middleware/errorHandler.js';

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

auditRouter.get('/', authenticate, requireAuth, requirePermission(Permission.AUDIT_READ), (req, res, next) => {
  try {
    const requestId = req.id;

    // ── Pagination parameter validation ──────────────────────────────────────
    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];

    const limitNum = rawLimit === undefined ? 20 : Number(rawLimit);
    const offsetNum = rawOffset === undefined ? 0 : Number(rawOffset);

    if (!Number.isFinite(limitNum) || !Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, 'limit must be an integer between 1 and 100', true);
    }
    if (!Number.isFinite(offsetNum) || !Number.isInteger(offsetNum) || offsetNum < 0) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, 'offset must be a non-negative integer', true);
    }

    const allEntries = getAuditEntries();
    const page = allEntries.slice(offsetNum, offsetNum + limitNum).map(sanitizeEntry);

    res.json(successResponse({ entries: page, total: allEntries.length }, requestId));
  } catch (err) {
    next(err);
  }
});
