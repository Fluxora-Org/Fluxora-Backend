import type { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/response.js';

/**
 * Parses the Accept header and returns the highest-priority media type.
 *
 * Follows RFC 7231 §5.3.2: each entry may carry an optional `q` parameter
 * (quality value, 0–1, default 1.0). Entries are sorted by descending quality;
 * within the same quality level the order of appearance is preserved.
 *
 * @param acceptHeader - Raw value of the Accept request header.
 * @returns Ordered list of media type strings (without parameters).
 */
function parseAcceptHeader(acceptHeader: string): string[] {
  return acceptHeader
    .split(',')
    .map((entry) => {
      const [mediaType, ...params] = entry.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1.0;
      return { mediaType: (mediaType ?? '').trim().toLowerCase(), q: isNaN(q) ? 1.0 : q };
    })
    .filter(({ mediaType }) => mediaType.length > 0)
    .sort((a, b) => b.q - a.q)
    .map(({ mediaType }) => mediaType);
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
 * Middleware that enforces JSON-only content negotiation on GET (and HEAD)
 * routes.
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
 * - `Accept: application/xml`    → 406 Not Acceptable
 * - `Accept: application/xml, application/json;q=0.9` → pass through (JSON
 *   is listed but at lower quality; the server can still satisfy with JSON)
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

  const types = parseAcceptHeader(acceptHeader);

  // Empty or unparseable header — treat as wildcard.
  if (types.length === 0) {
    next();
    return;
  }

  // If *any* of the listed types is JSON-acceptable the server can satisfy
  // the request; proceed normally.
  const canSatisfy = types.some(isJsonAcceptable);
  if (canSatisfy) {
    next();
    return;
  }

  const requestId = req.id ?? (res.locals['requestId'] as string | undefined);
  res.status(406).json(
    errorResponse(
      'NOT_ACCEPTABLE',
      'This endpoint only produces application/json responses',
      undefined,
      requestId,
    ),
  );
}
