/**
 * Audit log routes.
 *
 * ## GET /api/audit
 *
 * Returns the in-process audit log. Intended for administrators only.
 * Public clients and authenticated partners must not be granted access to
 * this route (enforce at the gateway / auth middleware layer).
 *
 * Query parameters:
 *   @param limit        - Number of entries to return. Must be 1–100. Defaults to 20.
 *                         Returns 400 if out of range.
 *   @param offset       - Zero-based offset into the audit log. Must be >= 0. Defaults to 0.
 *                         Returns 400 if negative.
 *   @param actor        - Filter by actor. Matches against `entry.meta.actor` or `entry.actor`.
 *   @param actionType   - Filter by action type (e.g. STREAM_CREATED, PAUSE_FLAGS_UPDATED).
 *   @param resourceType - Filter by affected resource type (e.g. `stream`).
 *   @param resourceId   - Filter by affected resource id.
 *   @param dateFrom     - ISO-8601 timestamp. Only include entries at or after this time.
 *   @param dateTo       - ISO-8601 timestamp. Only include entries at or before this time.
 *
 * Response shape:
 *   { success: true, data: { entries: AuditEntry[], total: number }, meta: ResponseMeta }
 *
 * Failure modes:
 *   - No entries yet → 200 with empty array (not 404).
 *   - limit out of range → 400 VALIDATION_ERROR
 *   - offset < 0 → 400 VALIDATION_ERROR
 *
 * ## GET /api/audit/export
 *
 * Streams the **durable** `audit_logs` table as CSV or NDJSON for offline
 * compliance review. See the handler below and `docs/api/audit.md` for the
 * full contract.
 *
 * Security notes:
 *   - The `details`/`meta` fields of audit entries are redacted of any RESTRICTED
 *     field names (authToken, authorization, x-api-key) before being returned.
 *     This prevents accidental exposure of credentials in audit records.
 *   - Both routes require a JWT carrying `Permission.AUDIT_READ` (held by the
 *     `admin` and `operator` roles).
 */

import { z } from 'zod';
import { Router, type Response } from 'express';
import { getAuditEntries, recordAuditEventToDb, type AuditEntry } from '../lib/auditLog.js';
import { successResponse } from '../utils/response.js';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { ApiError } from '../errors.js';
import { ApiErrorCode } from '../middleware/errorHandler.js';
import { OffsetPaginationSchema, DEFAULT_PAGE_LIMIT } from '../validation/paginationSchema.js';
import {
  auditRepository,
  type AuditLogFilter,
  type AuditLogRow,
} from '../db/repositories/auditRepository.js';
import { logger } from '../lib/logger.js';

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

// ── Shared filter schema ──────────────────────────────────────────────────────

/**
 * Filter parameters understood by *both* the paginated listing and the
 * streaming export, so the two always describe the same population.
 *
 * The export applies a stricter shape on top of this (see
 * {@link AuditExportQuerySchema}) because its date bounds are pushed down into
 * SQL, where a malformed value would silently produce the wrong range rather
 * than an obviously empty page.
 */
const AuditFilterSchema = z.object({
  actor: z.string().optional(),
  actionType: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

/** Extended schema that adds filter params on top of offset pagination. */
const AuditQuerySchema = OffsetPaginationSchema.extend(AuditFilterSchema.shape);

// ── Export schema ─────────────────────────────────────────────────────────────

/** Serialisation formats the export endpoint can emit. */
const EXPORT_FORMATS = ['csv', 'ndjson'] as const;
export type AuditExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * True when a regex-shaped ISO instant also denotes a real calendar date.
 *
 * `Date.parse` alone is not enough: JavaScript silently rolls `2026-02-31`
 * over to `2026-03-03`, which would hand back a range the caller never asked
 * for. Comparing the parsed UTC components back against the literal rejects
 * both overflowed dates and an out-of-range `24:00:00`.
 */
function isRealCalendarInstant(value: string): boolean {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
    parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getUTCDate() === Number(value.slice(8, 10))
  );
}

/**
 * ISO-8601 instant, e.g. `2026-01-31T12:00:00.000Z`.
 *
 * The `audit_logs.timestamp` column is `text` holding ISO-8601 UTC strings, so
 * the SQL range predicate is a lexicographic comparison. That is only
 * equivalent to a chronological comparison for well-formed, fixed-width UTC
 * strings — hence the strict check here rather than a free-form string.
 */
const IsoInstantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    'must be an ISO-8601 UTC instant, e.g. 2026-01-31T12:00:00.000Z',
  )
  .refine(isRealCalendarInstant, 'must be a valid calendar date');

const AuditExportQuerySchema = AuditFilterSchema.extend({
  format: z.enum(EXPORT_FORMATS).optional(),
  dateFrom: IsoInstantSchema.optional(),
  dateTo: IsoInstantSchema.optional(),
}).refine(
  (q) => q.dateFrom === undefined || q.dateTo === undefined || q.dateFrom <= q.dateTo,
  { message: 'must be less than or equal to dateTo', path: ['dateFrom'] },
);

// ── CSV serialisation ─────────────────────────────────────────────────────────

/** Column order of the CSV export. Also emitted as the header row. */
const CSV_COLUMNS = [
  'id',
  'seq',
  'timestamp',
  'action',
  'resource_type',
  'resource_id',
  'correlation_id',
  'meta',
] as const;

/**
 * Leading characters a spreadsheet interprets as the start of a formula.
 *
 * Audit `meta` can contain operator- or client-supplied text, so a cell such as
 * `=HYPERLINK("http://evil","click")` would execute on open in Excel / Sheets /
 * LibreOffice. Prefixing with an apostrophe neutralises it while keeping the
 * value readable.
 */
const CSV_FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Render one value as an RFC 4180 CSV field.
 *
 * Every field is quoted unconditionally (simpler to reason about than
 * conditional quoting) and embedded quotes are doubled. Values that would be
 * read as a formula are prefixed with `'`.
 *
 * @security This is the CSV-injection boundary. Do not build CSV cells any
 *           other way.
 */
export function toCsvField(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const first = raw.charAt(0);
  const guarded = raw.length > 0 && CSV_FORMULA_TRIGGERS.has(first) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Serialise one audit row as a CSV record (including its trailing newline). */
export function auditRowToCsv(row: AuditLogRow): string {
  const meta = row.meta === null ? '' : JSON.stringify(redactRestricted(row.meta));
  return (
    [
      toCsvField(row.id),
      toCsvField(row.seq),
      toCsvField(row.timestamp),
      toCsvField(row.action),
      toCsvField(row.resourceType),
      toCsvField(row.resourceId),
      toCsvField(row.correlationId),
      toCsvField(meta),
    ].join(',') + '\n'
  );
}

/** Serialise one audit row as an NDJSON record (including its trailing newline). */
export function auditRowToNdjson(row: AuditLogRow): string {
  return (
    JSON.stringify({
      id: row.id,
      seq: row.seq,
      timestamp: row.timestamp,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      correlationId: row.correlationId,
      meta: row.meta === null ? null : redactRestricted(row.meta),
    }) + '\n'
  );
}

// ── Streaming helpers ─────────────────────────────────────────────────────────

/**
 * Write a chunk, respecting backpressure.
 *
 * When the socket buffer is full `res.write` returns false; we then wait for
 * `drain` before producing more. Without this the whole export would pile up in
 * the process heap whenever the client reads slower than Postgres delivers —
 * exactly the failure this endpoint exists to avoid.
 *
 * @returns `false` if the response is no longer writable (client hung up).
 */
async function writeChunk(res: Response, chunk: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;
  if (res.write(chunk)) return true;

  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });

  return !res.writableEnded && !res.destroyed;
}

/** Build a safe, server-generated download filename. No user input is used. */
function exportFilename(format: AuditExportFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `audit-export-${stamp}.${format}`;
}

// ── GET /api/audit ────────────────────────────────────────────────────────────

auditRouter.get('/', authenticate, requireAuth, requirePermission(Permission.AUDIT_READ), (req, res, next) => {
  try {
    const requestId = req.correlationId;

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, firstIssue?.message ?? 'Invalid query parameters', true);
    }

    const { limit, offset, actor, actionType, resourceType, resourceId, dateFrom, dateTo } = parsed.data;
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

    if (resourceType !== undefined) {
      filteredEntries = filteredEntries.filter((e) => e.resourceType === resourceType);
    }

    if (resourceId !== undefined) {
      filteredEntries = filteredEntries.filter((e) => e.resourceId === resourceId);
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

// ── GET /api/audit/export ─────────────────────────────────────────────────────

/**
 * Stream matching `audit_logs` rows to the response as CSV or NDJSON.
 *
 * Unlike `GET /api/audit` — which serves the process-local in-memory ring —
 * the export reads the durable table, so it covers rows written by every
 * instance for the whole retention window.
 *
 * Query parameters: the same filters as the listing (`actor`, `actionType`,
 * `resourceType`, `resourceId`, `dateFrom`, `dateTo`), plus `format`
 * (`csv` — default — or `ndjson`). `dateFrom`/`dateTo` must be ISO-8601 UTC
 * instants here because they are pushed down into SQL.
 *
 * Behaviour:
 *   - Rows are fetched in keyset-paginated batches and written straight to the
 *     socket. The full result set is never held in memory.
 *   - Writes respect backpressure, so a slow client throttles the export rather
 *     than inflating the heap.
 *   - A client disconnect aborts the run before the next database round-trip.
 *
 * Failure modes:
 *   - Missing/!valid JWT → 401; JWT without `audit:read` → 403.
 *   - Malformed `format` or date → 400 VALIDATION_ERROR.
 *   - The self-audit write failing → 500, and **no data is exported**.
 *   - A database error after streaming began → the response is destroyed, so
 *     the client sees a truncated transfer rather than a silently short file.
 *
 * @security
 *   - Requires `Permission.AUDIT_READ` (roles `admin` and `operator`).
 *   - The export itself writes an `AUDIT_EXPORTED` row *before* any data is
 *     read, recording who exported which range. Exporting the audit trail is
 *     itself an auditable event, and it fails closed.
 *   - CSV cells are escaped against spreadsheet formula injection; `meta` is
 *     redacted of credential-shaped fields exactly as in the listing.
 *   - The download filename is generated server-side, so no user input can
 *     reach the `Content-Disposition` header.
 */
auditRouter.get(
  '/export',
  authenticate,
  requireAuth,
  requirePermission(Permission.AUDIT_READ),
  async (req, res, next) => {
    const requestId = req.correlationId;

    const parsed = AuditExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      // Name the offending parameter — with six filters in play, "Invalid
      // enum value" on its own is not actionable.
      const field = firstIssue?.path?.join('.');
      const detail = firstIssue?.message ?? 'Invalid query parameters';
      next(
        new ApiError(
          400,
          ApiErrorCode.VALIDATION_ERROR,
          field ? `${field}: ${detail}` : detail,
          undefined,
          true,
        ),
      );
      return;
    }

    const { actor, actionType, resourceType, resourceId, dateFrom, dateTo } = parsed.data;
    const format: AuditExportFormat = parsed.data.format ?? 'csv';

    const filter: AuditLogFilter = {
      actor,
      action: actionType,
      resourceType,
      resourceId,
      dateFrom,
      dateTo,
    };

    // Identify the principal for the self-audit record. `authenticate` +
    // `requireAuth` guarantee `req.user` exists by this point.
    const principal = req.user as unknown as { address?: string; role?: string } | undefined;
    const exporter = principal?.address ?? 'unknown';

    // ── Self-audit, before any data is read ──────────────────────────────────
    //
    // Written first, and fatally, so an export can never happen without a
    // durable record of who asked for what. Recording intent up front also
    // means an export that is aborted or fails mid-stream still leaves a trail.
    try {
      await recordAuditEventToDb(
        'AUDIT_EXPORTED',
        'audit_logs',
        `${dateFrom ?? 'beginning'}..${dateTo ?? 'latest'}`,
        requestId,
        {
          actor: exporter,
          role: principal?.role ?? 'unknown',
          format,
          filters: { actor, actionType, resourceType, resourceId, dateFrom, dateTo },
        },
      );
    } catch (err) {
      logger.error('audit_export_self_audit_failed', requestId, {
        event: 'audit_export_self_audit_failed',
        actor: exporter,
        err: err instanceof Error ? err.message : String(err),
      });
      next(
        new ApiError(
          500,
          ApiErrorCode.INTERNAL_ERROR,
          'Unable to record the export in the audit log; export refused.',
          undefined,
          false,
        ),
      );
      return;
    }

    // ── Response headers ─────────────────────────────────────────────────────
    res.status(200);
    res.setHeader(
      'Content-Type',
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(format)}"`);
    // Defence in depth: stop a browser from sniffing the body into something
    // renderable (and stop caches from retaining audit data).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    // Cooperative cancellation: stop hitting the database the moment the
    // client goes away.
    const abortState = { aborted: false };
    res.on('close', () => {
      if (!res.writableEnded) abortState.aborted = true;
    });

    let rowsWritten = 0;
    try {
      if (format === 'csv') {
        if (!(await writeChunk(res, `${CSV_COLUMNS.join(',')}\n`))) return;
      }

      for await (const row of auditRepository.streamFiltered(filter, { signal: abortState })) {
        const chunk = format === 'csv' ? auditRowToCsv(row) : auditRowToNdjson(row);
        if (!(await writeChunk(res, chunk))) break;
        rowsWritten++;
      }

      if (!res.writableEnded && !res.destroyed) res.end();

      logger.info('audit_export_completed', requestId, {
        event: 'audit_export_completed',
        actor: exporter,
        format,
        rows: rowsWritten,
        aborted: abortState.aborted,
        dateFrom: dateFrom ?? null,
        dateTo: dateTo ?? null,
      });
    } catch (err) {
      logger.error('audit_export_failed', requestId, {
        event: 'audit_export_failed',
        actor: exporter,
        format,
        rows: rowsWritten,
        err: err instanceof Error ? err.message : String(err),
      });

      if (res.headersSent) {
        // The status line is already on the wire, so we cannot turn this into a
        // JSON error. Destroying the socket makes the transfer fail loudly
        // instead of handing the auditor a silently truncated "complete" file.
        res.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      next(err);
    }
  },
);
