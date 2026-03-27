/**
 * GET /api/audit
 *
 * Returns the in-process audit log. Intended for administrators only.
 * Public clients and authenticated partners must not be granted access to
 * this route (enforce at the gateway / auth middleware layer).
 *
 * Response shape:
 *   { entries: AuditEntry[], total: number }
 *
 * Failure modes:
 *   - No entries yet → 200 with empty array (not 404).
 */

import { Router } from 'express';
import { getAuditEntries } from '../lib/auditLog.js';

export const auditRouter = Router();

auditRouter.get('/', (_req, res) => {
  const entries = getAuditEntries();
  res.json({ entries, total: entries.length });
});
