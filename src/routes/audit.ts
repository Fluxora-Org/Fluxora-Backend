/**
 * GET /api/audit
 *
 * Returns the in-process audit log. Intended for administrators only.
 * Public clients and authenticated partners must not be granted access to
 * this route (enforce at the gateway / auth middleware layer).
 *
 * Response shape:
 *   { success: true, data: { entries: AuditEntry[], total: number }, meta: ResponseMeta }
 *
 * Failure modes:
 *   - No entries yet → 200 with empty array (not 404).
 */

import { Router } from 'express';
import { getAuditEntries } from '../lib/auditLog.js';
import { successResponse } from '../utils/response.js';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';

export const auditRouter = Router();

auditRouter.get('/', authenticate, requireAuth, requirePermission(Permission.AUDIT_READ), (req, res) => {
  const requestId = req.id;
  const entries = getAuditEntries();
  res.json(successResponse({ entries, total: entries.length }, requestId));
});
