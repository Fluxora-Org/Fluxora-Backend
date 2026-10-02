import type { Request, Response, NextFunction } from 'express';
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

  // No Accept header — implicit wildcard, always acceptable.
  if (!acceptHeader) {
    next();
    return;
  }

  const entries = parseAcceptHeader(acceptHeader);

  // Empty or unparseable header — treat as wildcard.
  if (entries.length === 0) {
    next();
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
