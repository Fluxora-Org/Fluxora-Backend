/**
 * Privacy policy endpoints.
 *
 * Exposes the PII policy, data classification schema, retention
 * schedule, and trust boundaries as machine-readable JSON so that
 * integrators and auditors can inspect what the service stores
 * without reading source code.
 *
 * Also provides the GDPR / data-subject right-to-erasure endpoint
 * (DELETE /api/privacy/erasure/:recipientAddress) for DPO-authorised
 * scrubbing of PII columns in the streams table.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  DataClassification,
} from '../pii/policy.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { getPool, query } from '../db/pool.js';
import { recordAuditEventToDb } from '../lib/auditLog.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { logger } from '../lib/logger.js';

export const privacyRouter = Router();

const SERVICE_NAME = 'fluxora-backend';
const SERVICE_VERSION = '0.1.0';

/**
 * Redaction tombstone written over PII columns when a data-subject erasure
 * request is fulfilled. The value is intentionally not a valid Stellar address
 * so it cannot be mistaken for real chain data.
 *
 * The prefix `[REDACTED:` is machine-readable; audit tools can scan for it.
 * The suffix `:GDPR-17]` references GDPR Article 17 (right to erasure).
 */
const ERASURE_TOMBSTONE = '[REDACTED:GDPR-17]';

/**
 * Middleware: set security and cache headers on every privacy response.
 *
 * Policy documents must not be cached by intermediaries — an operator
 * updating the policy should see the change immediately.
 */
function privacyHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

privacyRouter.use(privacyHeaders);

/**
 * Reject HTTP methods other than GET and HEAD on policy/retention routes.
 * The /erasure/:recipientAddress route is registered separately with its own
 * method (DELETE) and is not covered by this middleware.
 *
 * HEAD is implicitly handled by Express for GET routes.
 */
function rejectUnsupportedMethods(req: Request, res: Response, next: NextFunction): void {
  // Allow the erasure route through without a 405 — it handles its own method (DELETE).
  if (req.path.startsWith('/erasure/') || req.path === '/erasure') {
    return next();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `${req.method} is not allowed on this resource`,
      },
    });
    return;
  }
  next();
}

privacyRouter.use(rejectUnsupportedMethods);

/**
 * GET /api/privacy/policy
 *
 * Returns the full PII policy document: field classifications,
 * retention schedule, and trust boundaries.
 */
privacyRouter.get('/policy', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    piiPolicy: {
      summary:
        'Fluxora stores only chain-derived pseudonymous data (Stellar public keys and ' +
        'on-chain amounts). No direct PII such as names, emails, or physical addresses ' +
        'is collected. HTTP request metadata (IP, user-agent) is ephemeral and never persisted.',
      dataClassifications: Object.values(DataClassification).map((level) => ({
        level,
        description: classificationDescription(level),
      })),
      fieldPolicies: {
        streamFields: STREAM_FIELD_POLICIES,
        requestFields: REQUEST_FIELD_POLICIES,
      },
      retentionSchedule: RETENTION_SCHEDULE,
      trustBoundaries: TRUST_BOUNDARIES,
    },
    _links: {
      self: '/api/privacy/policy',
      retention: '/api/privacy/retention',
      health: '/health',
      streams: '/api/streams',
    },
  });
});

/**
 * GET /api/privacy/retention
 *
 * Lightweight view of just the retention schedule for quick
 * compliance checks.
 */
privacyRouter.get('/retention', (_req: Request, res: Response) => {
  res.json({
    retentionSchedule: RETENTION_SCHEDULE,
    _links: {
      self: '/api/privacy/retention',
      fullPolicy: '/api/privacy/policy',
    },
  });
});

/** Map a classification enum value to a human-readable description. */
function classificationDescription(level: DataClassification): string {
  switch (level) {
    case DataClassification.PUBLIC:
      return 'Freely shareable; no privacy implications.';
    case DataClassification.INTERNAL:
      return 'Operational data visible to authenticated users and operators.';
    case DataClassification.SENSITIVE:
      return 'Pseudonymous identifiers that could be correlated to real identities. Redacted in logs.';
    case DataClassification.RESTRICTED:
      return 'Credentials or direct PII. Never persisted, never logged.';
  }
}

// ── GDPR Right-to-Erasure ─────────────────────────────────────────────────────

/**
 * DELETE /api/privacy/erasure/:recipientAddress
 *
 * Fulfils a GDPR Article 17 right-to-erasure request for a data subject
 * identified by their Stellar recipient address.
 *
 * What is erased:
 *   - `sender_address`         → replaced with ERASURE_TOMBSTONE
 *   - `recipient_address`      → replaced with ERASURE_TOMBSTONE
 *   - `sender_address_hash`    → cleared to NULL (hash no longer valid)
 *   - `recipient_address_hash` → cleared to NULL (hash no longer valid)
 *
 * What is preserved (financial / audit integrity):
 *   - `amount`        — amounts must survive for financial audit trails
 *   - `ledger`        — ledger sequence numbers are public chain data
 *   - `stream_id`     — opaque internal identifier, not PII
 *   - `status`        — stream lifecycle, not PII
 *   - All `contract_events` rows — amounts/ledger refs are chain-public
 *   - All `audit_logs` entries — immutable audit trail; a new entry is
 *                                 appended for the erasure itself
 *
 * Security requirements:
 *   - Requires admin or DPO Bearer token (via requireAdminAuth).
 *   - Every call is written to audit_logs with requester identity.
 *   - The recipient address parameter is length-bounded and validated
 *     before use; it is never interpolated directly into SQL (parameterised).
 *   - Streams under legal hold (legal_hold = TRUE) are skipped; their
 *     count is reported in the response.
 *
 * Idempotency:
 *   - Re-running with the same address is safe; already-tombstoned rows
 *     match the WHERE clause only once (tombstone ≠ valid address).
 *
 * Response codes:
 *   200 — erasure completed (may be 0 rows if address not found)
 *   400 — invalid recipientAddress parameter
 *   401 — missing Authorization header
 *   403 — invalid credentials
 *   500 — internal error (audit entry still attempted)
 */
privacyRouter.delete(
  '/erasure/:recipientAddress',
  requireAdminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { recipientAddress } = req.params;
    const correlationId = getCorrelationId();

    // ── Input validation ──────────────────────────────────────────────────
    // Stellar addresses are 56-char G… public keys; we accept any non-empty
    // string up to 256 chars to handle edge cases without being too strict
    // at the route layer (the DB query is parameterised regardless).
    if (
      typeof recipientAddress !== 'string' ||
      recipientAddress.trim().length === 0 ||
      recipientAddress.length > 256
    ) {
      res.status(400).json({
        error: {
          code: 'INVALID_ADDRESS',
          message: 'recipientAddress must be a non-empty string of at most 256 characters.',
        },
      });
      return;
    }

    const address = recipientAddress.trim();

    logger.info('PII erasure request received', correlationId, {
      event: 'pii_erasure_request',
      // Log only first 8 chars of address — enough for correlation without
      // leaking the full pseudonymous identifier.
      addressPrefix: address.substring(0, 8),
    });

    const pool = getPool();

    try {
      // ── Erasure query ─────────────────────────────────────────────────────
      // We match rows where the recipient_address equals the supplied value
      // OR where the sender_address equals it (a subject may appear on both
      // sides of a stream).  The tombstone is written to both address columns
      // on every matched row.
      //
      // Rows with legal_hold = TRUE are excluded; their count is returned so
      // the caller knows not all data was erased.
      //
      // Security: address is passed as a parameterised value — never
      // interpolated into SQL text.
      const result = await query(
        pool,
        `UPDATE streams
            SET sender_address        = $1,
                recipient_address     = $1,
                sender_address_hash   = NULL,
                recipient_address_hash = NULL
          WHERE (recipient_address = $2 OR sender_address = $2)
            AND COALESCE(legal_hold, FALSE) = FALSE`,
        [ERASURE_TOMBSTONE, address],
      );

      const rowsErased = result.rowCount ?? 0;

      // Count legal-hold rows that were skipped (separate read query —
      // no mutation needed, just informational).
      const holdResult = await query(
        pool,
        `SELECT COUNT(*) AS cnt
           FROM streams
          WHERE (recipient_address = $1 OR sender_address = $1)
            AND legal_hold = TRUE`,
        [address],
      );
      const rowsSkippedLegalHold = parseInt(
        (holdResult.rows[0] as { cnt: string } | undefined)?.cnt ?? '0',
        10,
      );

      // ── Audit trail ───────────────────────────────────────────────────────
      // Write a durable audit entry AFTER the erasure so that the DB is
      // consistent even if the audit write fails (we log the failure rather
      // than rolling back the erasure).
      try {
        await recordAuditEventToDb(
          'PII_ERASURE_REQUESTED',
          'streams',
          address.substring(0, 8) + '…', // truncated; never log full address
          correlationId,
          {
            rowsErased,
            rowsSkippedLegalHold,
            requestedBy: (req.headers.authorization ?? '').substring(0, 16) + '…',
          },
        );
      } catch (auditErr) {
        // Audit failure must never suppress a successful erasure response.
        logger.error('Failed to write erasure audit entry', correlationId, {
          event: 'pii_erasure_audit_failed',
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }

      logger.info('PII erasure completed', correlationId, {
        event: 'pii_erasure_completed',
        rowsErased,
        rowsSkippedLegalHold,
      });

      res.status(200).json({
        erased: true,
        rowsErased,
        rowsSkippedLegalHold,
        message:
          rowsSkippedLegalHold > 0
            ? `${rowsErased} row(s) erased. ${rowsSkippedLegalHold} row(s) skipped due to legal hold.`
            : `${rowsErased} row(s) erased.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('PII erasure failed', correlationId, {
        event: 'pii_erasure_failed',
        error: message,
      });

      // Attempt a best-effort audit entry for the failure.
      try {
        await recordAuditEventToDb(
          'PII_ERASURE_REQUESTED',
          'streams',
          address.substring(0, 8) + '…',
          correlationId,
          { error: message, outcome: 'failed' },
        );
      } catch {
        // ignore nested failure
      }

      res.status(500).json({
        error: {
          code: 'ERASURE_FAILED',
          message: 'An internal error occurred while processing the erasure request.',
        },
      });
    }
  },
);
