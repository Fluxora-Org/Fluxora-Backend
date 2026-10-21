import type { Request, Response, NextFunction } from 'express';
import { ApiError, ApiErrorCode } from '../errors.js';
import { errorResponse } from '../utils/response.js';

/** A single parsed `Accept` header entry with its RFC 9110 quality value. */
interface AcceptEntry {
  /** Media range exactly as listed by the client, lower-cased. */
  mediaType: string;
  /** Quality value in the range 0–1 (`q=0` means "not acceptable"). */
  q: number;
}

const DEFAULT_QUALITY = 1.0;

/**
 * Maximum accepted length of the raw `Accept` header value.
 *
 * Matches the 8 KiB header limit already used for other request headers in this
 * codebase (e.g. `Authorization`). Longer values are rejected before parsing.
 */
export const MAX_ACCEPT_HEADER_LENGTH = 8192;

export type AcceptRejectionReason = 'empty' | 'oversized' | 'malformed';

/**
 * Typed error passed to `next()` when the `Accept` header cannot be validated.
 * Extends `ApiError` so the standard error handler converts it into the normal
 * error envelope with an appropriate status code.
 */
export class AcceptNegotiationValidationError extends ApiError {
  public readonly reason: AcceptRejectionReason;

  constructor(message: string, reason: AcceptRejectionReason) {
    const statusCode = reason === 'oversized' ? 413 : 400;
    const code =
      reason === 'oversized' ? ApiErrorCode.PAYLOAD_TOO_LARGE : ApiErrorCode.VALIDATION_ERROR;
    super(statusCode, code, message, { reason });
    this.name = 'AcceptNegotiationValidationError';
    this.reason = reason;
  }
}

const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const MEDIA_RANGE_PATTERN = new RegExp(`^(?:\\*/\\*|(?!\\*)${TOKEN}/(?:${TOKEN}|\\*))$`);
const PARAMETER_PATTERN = new RegExp(`^${TOKEN}=(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*")$`);

/**
 * Validates the raw `Accept` header before it is parsed.
 *
 * Rejects non-string, empty/whitespace-only, oversized, and structurally
 * malformed values with a typed {@link AcceptNegotiationValidationError}.
 * A missing header is not passed here: RFC 9110 treats it as an implicit `*\/*`.
 */
export function validateAcceptHeader(acceptHeader: unknown): string {
  if (typeof acceptHeader !== 'string') {
    throw new AcceptNegotiationValidationError(
      'Accept header must be a string',
      'malformed',
    );
  }

  if (acceptHeader.trim().length === 0) {
    throw new AcceptNegotiationValidationError('Accept header cannot be empty', 'empty');
  }

  if (acceptHeader.length > MAX_ACCEPT_HEADER_LENGTH) {
    throw new AcceptNegotiationValidationError(
      `Accept header exceeds maximum allowed length of ${MAX_ACCEPT_HEADER_LENGTH} characters`,
      'oversized',
    );
  }

  // Allow HTAB as optional whitespace, but reject other control characters.
  if (/[\r\n\0\x00-\x08\x0A-\x1F\x7F]/.test(acceptHeader)) {
    throw new AcceptNegotiationValidationError(
      'Accept header contains forbidden control characters',
      'malformed',
    );
  }

  for (const entry of acceptHeader.split(',')) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry.length === 0) {
      throw new AcceptNegotiationValidationError(
        'Accept header contains an empty media range',
        'malformed',
      );
    }

    const [rawMediaType, ...params] = trimmedEntry.split(';');
    const mediaType = (rawMediaType ?? '').trim().toLowerCase();
    if (!MEDIA_RANGE_PATTERN.test(mediaType)) {
      throw new AcceptNegotiationValidationError(
        'Accept header contains a malformed media range',
        'malformed',
      );
    }

    for (const param of params) {
      if (!PARAMETER_PATTERN.test(param.trim())) {
        throw new AcceptNegotiationValidationError(
          'Accept header contains a malformed parameter',
          'malformed',
        );
      }
    }
  }

  return acceptHeader;
}

/**
 * Parses the Accept header into media-type/quality pairs.
 *
 * Follows RFC 9110 §12.4.2: each entry may carry an optional `q` parameter
 * (quality value, 0–1, default 1.0). Entries are sorted by descending quality;
 * within the same quality level the order of appearance is preserved.
 *
 * A `q=0` entry marks that media range as explicitly **not acceptable** and is
 * therefore excluded from the returned list. Media ranges without a `q`
 * parameter default to `1.0`; malformed or out-of-range values fall back to
 * `1.0` and are clamped to `[0, 1]` respectively.
 *
 * @param acceptHeader - Raw value of the Accept request header.
 * @returns Ordered list of acceptable media types with their quality values.
 */
function parseAcceptHeader(acceptHeader: string): AcceptEntry[] {
  return acceptHeader
    .split(',')
    .map((entry) => {
      const [rawMediaType, ...params] = entry.trim().split(';');
      const qParam = params.find((p) => p.trim().toLowerCase().startsWith('q='));
      const parsedQ = qParam ? parseFloat(qParam.trim().slice(2)) : DEFAULT_QUALITY;
      const q = Number.isNaN(parsedQ) ? DEFAULT_QUALITY : Math.min(Math.max(parsedQ, 0), 1);
      return { mediaType: (rawMediaType ?? '').trim().toLowerCase(), q };
    })
    .filter(({ mediaType }) => mediaType.length > 0)
    .sort((a, b) => b.q - a.q);
}

/**
 * Returns `true` when the media type is acceptable for a JSON-only endpoint.
 *
 * Acceptable values:
 * - `*\/*`               (wildcard — client accepts anything)
 * - `application/*`     (application wildcard)
 * - `application/json`  (exact JSON match)
 * - `application/*+json` (vendor JSON subtypes, e.g. application/vnd.api+json)
 */
function isJsonAcceptable(mediaType: string): boolean {
  return (
    mediaType === '*/*' ||
    mediaType === 'application/*' ||
    mediaType === 'application/json' ||
    (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
  );
}

/**
 * Middleware that enforces JSON-only content negotiation on all `/api` routes.
 *
 * When a client sends an `Accept` header that cannot be satisfied by
 * `application/json` — for example `Accept: application/xml` — this
 * middleware responds with `406 Not Acceptable` and a standard error envelope.
 *
 * Behaviour matrix:
 * - No Accept header              → pass through (implicit *\/*)
 * - `Accept: *\/*`                → pass through
 * - `Accept: application/json`   → pass through
 * - `Accept: application/*`      → pass through
 * - `Accept: application/*+json` → pass through
 * - `Accept: application/xml`    → 406 Not Acceptable
 * - `Accept: application/xml, application/json;q=0.9` → pass through (JSON
 *   is listed at a lower quality; the server can still satisfy with JSON)
 * - `Accept: application/json;q=0` → 406 Not Acceptable (`q=0` disallows the
 *   media range, so the server has nothing it can produce)
 * - Empty, oversized or malformed header → 400/413 with a typed validation
 *   error passed to the standard error handler
 *
 * Security note: the raw `Accept` header value is **not** echoed in the
 * response body to prevent header-injection reflection.
 */
export function requireJsonAccept(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const acceptHeader = req.headers['accept'];

  // No Accept header — implicit wildcard, always acceptable. An empty header
  // value is *not* the same as an absent header and is rejected below.
  if (acceptHeader === undefined) {
    next();
    return;
  }

  let entries: AcceptEntry[];
  try {
    validateAcceptHeader(acceptHeader);
    entries = parseAcceptHeader(acceptHeader);
  } catch (err) {
    // Reject invalid input before any response headers or body are written.
    next(err);
    return;
  }

  // RFC 9110 §12.4.2: `q=0` means the media range is explicitly unacceptable,
  // so it must not be used to satisfy the request.
  const acceptable = entries.filter((entry) => entry.q > 0);

  // If *any* of the listed (and acceptable) types is JSON-acceptable the server
  // can satisfy the request; proceed normally.
  const canSatisfy = acceptable.some((entry) => isJsonAcceptable(entry.mediaType));
  if (canSatisfy) {
    next();
    return;
  }

  const requestId = req.correlationId ?? (res.locals['requestId'] as string | undefined);
  res.status(406).json(
    errorResponse(
      'NOT_ACCEPTABLE',
      'This endpoint only produces application/json responses',
      undefined,
      requestId,
    ),
  );
}
