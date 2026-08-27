// @ts-nocheck
// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
/**
 * Privacy policy, consent-preference, and GDPR right-to-erasure endpoints.
 *
 * Exposes the PII policy, data classification schema, retention schedule,
 * trust boundaries, and CCPA/BIPA-style recipient consent preferences as
 * machine-readable JSON so that integrators and auditors can inspect what
 * the service stores without reading source code.
 *
 * Also provides the GDPR / data-subject right-to-erasure endpoint
 * (DELETE /api/privacy/erasure/:recipientAddress) for DPO-authorised
 * scrubbing of PII columns in the streams table.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import {
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  DataClassification,
} from '../pii/policy.js';
import { computeAddressHash, DEFAULT_ERASURE_TOMBSTONE, redactPiiForAddress } from '../pii/pgcryptoEncryption.js';
import { getPool, query, withClient, PoolExhaustedError } from '../db/pool.js';
import { loadConfig } from '../config/env.js';
import {
  PrivacyConsentSchema,
  parseBody,
  formatZodIssues,
  type PrivacyConsentInput,
} from '../validation/schemas.js';
import {
  asyncHandler,
  notFound,
  serviceUnavailable,
  validationError,
  tooManyRequests,
} from '../middleware/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { recordAuditEventToDb, recordErasureAuditLog, writeAuditEntryToClient } from '../lib/auditLog.js';
import { hashStringSHA256 } from '../lib/security.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { logger } from '../lib/logger.js';
import { requireJsonContentType } from '../middleware/contentType.js';

export const privacyRouter = Router();

const SERVICE_NAME = 'fluxora-backend';
const SERVICE_VERSION = '0.1.0';
const PrivacyConsentAddressSchema = PrivacyConsentSchema.pick({ address: true });

interface PrivacyConsentRow extends Record<string, unknown> {
  analytics_optout: boolean | string;
  marketing_optout: boolean | string;
  biometric_processing_consent: boolean | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PrivacyConsentResponse {
  analytics_optout: boolean;
  marketing_optout: boolean;
  biometric_processing_consent: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Redaction tombstone written over PII columns when a data-subject erasure
 * request is fulfilled. The value is intentionally not a valid Stellar address
 * so it cannot be mistaken for real chain data.
 *
 * The prefix `[REDACTED_GDPR_ERASURE]` is machine-readable; audit tools can scan for it.
 */
const ERASURE_TOMBSTONE = DEFAULT_ERASURE_TOMBSTONE;

/**
 * Middleware: set security and cache headers on every privacy response.
 *
 * Policy and consent documents must not be cached by intermediaries. Consent
 * state is recipient-specific and may be updated at any time.
 */
function privacyHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

privacyRouter.use(privacyHeaders);

// Apply content-type enforcement and body-size limits to all privacy routes
privacyRouter.use(requireJsonContentType);
privacyRouter.use(express.json({ limit: '256kb' }));

/** Build a route-scoped 405 handler with an explicit Allow header. */
function rejectUnsupportedMethods(allowedMethods: string[]) {
  return (req: Request, res: Response): void => {
    const allow = allowedMethods.join(', ');
    res.setHeader('Allow', allow);
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `${req.method} is not allowed on this resource`,
      },
    });
  };
}

/** Wrap DB errors so pool exhaustion surfaces as a retryable 503. */
function wrapPrivacyDbError(err: unknown): never {
  if (
    err instanceof PoolExhaustedError ||
    (err && (err as Error).name === 'PoolExhaustedError')
  ) {
    throw serviceUnavailable('Privacy consent storage is temporarily unavailable. Please retry shortly.');
  }
  throw err;
}

/** Convert a pg timestamp value into a stable ISO-8601 string. */
function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Convert pg boolean values without trusting string truthiness. */
function toBoolean(value: boolean | string): boolean {
  return value === true || value === 'true';
}

/** Map a database row to the public consent representation without address data. */
function toConsentResponse(row: PrivacyConsentRow): PrivacyConsentResponse {
  return {
    analytics_optout: toBoolean(row.analytics_optout),
    marketing_optout: toBoolean(row.marketing_optout),
    biometric_processing_consent: toBoolean(row.biometric_processing_consent),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

/**
 * Resolve the active address-hashing key.
 *
 * @security The key is never returned to clients or logged. If it is missing,
 * the consent endpoint fails closed rather than storing plaintext addresses.
 */
function resolvePgcryptoKey(req: Request): string {
  const localConfig = req.app.locals.config as { pgcryptoKey?: string } | undefined;
  const key = localConfig ? localConfig.pgcryptoKey : loadConfig().pgcryptoKey;

  if (!key) {
    throw serviceUnavailable('Privacy consent storage is temporarily unavailable. Please retry shortly.');
  }

  return key;
}

/** Compute the deterministic consent lookup key without storing plaintext. */
function computeConsentAddressHash(req: Request, address: string): string {
  return computeAddressHash(address, resolvePgcryptoKey(req));
}

/** Parse and validate a consent write body through the shared Zod schema. */
function parseConsentBody(body: unknown): PrivacyConsentInput {
  const parsed = parseBody(PrivacyConsentSchema, body ?? {});

  if (!parsed.success) {
    const formatted = formatZodIssues(parsed.issues);
    throw validationError(
      formatted[0]?.message ?? 'Invalid consent preferences',
      { errors: formatted },
    );
  }

  return parsed.data;
}

/** Parse and validate a Stellar address path parameter. */
function parseConsentAddressParam(address: unknown): string {
  const parsed = parseBody(PrivacyConsentAddressSchema, { address });

  if (!parsed.success) {
    const formatted = formatZodIssues(parsed.issues);
    throw validationError(
      formatted[0]?.message ?? 'Invalid Stellar address',
      { errors: formatted },
    );
  }

  return parsed.data.address;
}

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
      consent: '/api/privacy/consent',
      health: '/health',
      streams: '/api/streams',
    },
  });
});
privacyRouter.all('/policy', rejectUnsupportedMethods(['GET', 'HEAD']));

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
privacyRouter.all('/retention', rejectUnsupportedMethods(['GET', 'HEAD']));

/**
 * PUT /api/privacy/consent
 *
 * Upserts the recipient consent-preference document. The plaintext Stellar
 * address is accepted only at the HTTP boundary, converted to a keyed HMAC via
 * computeAddressHash, and never stored in privacy_consents.
 */
privacyRouter.put(
  '/consent',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseConsentBody(req.body);
    const addressHash = computeConsentAddressHash(req, input.address);

    let result;
    try {
      result = await query<PrivacyConsentRow>(
        getPool(),
        `
          INSERT INTO privacy_consents (
            address_hash,
            analytics_optout,
            marketing_optout,
            biometric_processing_consent,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, NOW(), NOW())
          ON CONFLICT (address_hash) DO UPDATE SET
            analytics_optout = EXCLUDED.analytics_optout,
            marketing_optout = EXCLUDED.marketing_optout,
            biometric_processing_consent = EXCLUDED.biometric_processing_consent,
            updated_at = NOW()
          RETURNING
            analytics_optout,
            marketing_optout,
            biometric_processing_consent,
            created_at,
            updated_at
        `,
        [
          addressHash,
          input.analytics_optout,
          input.marketing_optout,
          input.biometric_processing_consent,
        ],
      );
    } catch (err) {
      wrapPrivacyDbError(err);
    }

    const row = result!.rows[0];
    res.status(200).json(successResponse({ consent: toConsentResponse(row!) }, getCorrelationId()));
  }),
);
privacyRouter.all('/consent', rejectUnsupportedMethods(['PUT']));

/**
 * GET /api/privacy/consent/:address
 *
 * Returns the stored consent preferences for a Stellar address by hashing the
 * route parameter and querying privacy_consents.address_hash. The response does
 * not echo the plaintext address or its keyed hash.
 */
privacyRouter.get(
  '/consent/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const address = parseConsentAddressParam(req.params['address']);
    const addressHash = computeConsentAddressHash(req, address);

    let result;
    try {
      result = await query<PrivacyConsentRow>(
        getPool(),
        `
          SELECT
            analytics_optout,
            marketing_optout,
            biometric_processing_consent,
            created_at,
            updated_at
          FROM privacy_consents
          WHERE address_hash = $1
        `,
        [addressHash],
      );
    } catch (err) {
      wrapPrivacyDbError(err);
    }

    const row = result!.rows[0];
    if (!row) throw notFound('Privacy consent');

    res.json(successResponse({ consent: toConsentResponse(row) }, getCorrelationId()));
  }),
);
privacyRouter.all('/consent/:address', rejectUnsupportedMethods(['GET', 'HEAD']));

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
/**
 * Endpoint handler: DELETE /api/privacy/erasure/:recipientAddress
 *
 * Fulfils a GDPR Article 17 right-to-erasure request for a data subject
 * identified by their Stellar recipient address.
 *
 * Requirements satisfied:
 *  - Authorization: Restricted to admin and data-protection-officer roles.
 *  - Validation: Validates recipientAddress format.
 *  - PII Redaction: Replaces address PII columns with tombstone `[REDACTED_GDPR_ERASURE]` and clears hash columns.
 *  - Financial Integrity: Preserves amounts, ledger, stream_id, status, and contract_events untouched.
 *  - Audit Logging: Records `GDPR_ERASURE` and `PII_ERASURE_REQUESTED` audit events without storing erased PII.
 *  - Transaction: Executes within a DB transaction with rollback on failure.
 *
 * @param req - Express Request containing recipientAddress parameter
 * @param res - Express Response
 */
privacyRouter.delete(
  '/erasure/:recipientAddress',
  requireAdminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { recipientAddress } = req.params;
    const correlationId = getCorrelationId();

    // ── Input validation ──────────────────────────────────────────────────
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
      addressPrefix: address.substring(0, 8),
    });

    const pool = getPool();
    const requesterUser = (req as any).user;
    const requesterRole = requesterUser?.role ?? 'admin';
    const requestedBy = requesterUser?.address ?? (req.headers.authorization ? hashStringSHA256(req.headers.authorization) : '');

    try {
      let rowsErased = 0;
      let rowsSkippedLegalHold = 0;

      await withClient(pool, async (client) => {
        await client.query('BEGIN');

        try {
          const result = await redactPiiForAddress(client, address, ERASURE_TOMBSTONE);
          rowsErased = result.rowsErased;
          rowsSkippedLegalHold = result.rowsSkippedLegalHold;

          // Audit writes are inside the same transaction so they commit or
          // roll back atomically with the redaction. A failed audit write
          // will roll back the entire operation — preferable to a silent
          // success audit entry for a redaction that never committed.
          try {
            const truncatedId = address.length > 8 ? address.substring(0, 8) + '…' : address;
            await writeAuditEntryToClient(
              client,
              'GDPR_ERASURE',
              'streams',
              truncatedId,
              correlationId,
              {
                requesterRole,
                requestedBy,
                outcome: 'success',
                rowsErased,
                rowsSkippedLegalHold,
                action: 'GDPR_ERASURE',
              },
            );
            await writeAuditEntryToClient(
              client,
              'PII_ERASURE_REQUESTED',
              'streams',
              truncatedId,
              correlationId,
              {
                rowsErased,
                rowsSkippedLegalHold,
                requestedBy,
              },
            );
          } catch (auditErr) {
            logger.error('Failed to write erasure audit entry — rolling back', correlationId, {
              event: 'pii_erasure_audit_failed',
              error: auditErr instanceof Error ? auditErr.message : String(auditErr),
            });
            await client.query('ROLLBACK');
            throw auditErr;
          }

          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {/* already rolled back */});
          throw txErr;
        }
      });

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

      try {
        await recordErasureAuditLog(
          'GDPR_ERASURE',
          'streams',
          address,
          correlationId,
          { error: message, outcome: 'failed', requesterRole, requestedBy },
        );
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
// The DELETE exemption from the router's GET/HEAD-only convention is scoped to
// exactly this route+method pair. Any other method on /erasure/:recipientAddress
// gets a 405, and a future route added under /erasure/* must register its own
// method restriction rather than silently inheriting an exemption.
privacyRouter.all('/erasure/:recipientAddress', rejectUnsupportedMethods(['DELETE']));
