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

export const auditRouter = Router();

auditRouter.get('/', (req, res) => {
  const requestId = (req as any).id as string | undefined;
  const entries = getAuditEntries();
  res.json(successResponse({ entries, total: entries.length }, requestId));
});
