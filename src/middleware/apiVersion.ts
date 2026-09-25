import type { Request, Response, NextFunction } from 'express';

/** Canonical request header name used for versioning. */
export const ACCEPT_VERSION_HEADER = 'accept-version';

/** Response header used to echo back the API version the server resolved for the request. */
export const API_VERSION_RESPONSE_HEADER = 'X-API-Version';

/**
 * Supported API versions.
 *
 * Documented in `docs/api/versioning.md`. A request that names any value
 * outside this list is refused with `400 unsupported_version` so clients
 * written against a retired contract fail loudly instead of being silently
 * served a newer one.
 */
export const SUPPORTED_VERSIONS: readonly string[] = ['v1'];

/**
 * Version served when a request omits the `Accept-Version` header entirely.
 * Documented in `docs/api/versioning.md`.
 */
export const DEFAULT_API_VERSION = 'v1';

/**
 * Normalizes the version string extracted from the header.
 * Maps values like "1", "1.0", and "v1" to "v1".
 * @param version The raw version string
 * @returns The normalized version string, or null if it's an unrecognized format.
 */
function normalizeVersion(version: string): string | null {
  const v = version.trim().toLowerCase();
  if (v === '1' || v === '1.0' || v === 'v1') {
    return 'v1';
  }
  return null;
}

/**
 * API Versioning middleware.
 *
 * Extracts the `Accept-Version` header from incoming requests.
 * If absent or blank, it resolves to the documented default ("v1").
 * If present but unsupported, it short-circuits the request with a 400 response
 * listing the supported versions.
 *
 * The resolved and validated version is attached to `req.apiVersion` and echoed
 * back in the `X-API-Version` response header so clients can assert which
 * contract served them.
 */
export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rawHeader = req.headers[ACCEPT_VERSION_HEADER];

  // Handle array of headers by taking the first one
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const requested = headerValue?.trim();

  // Absent or blank header resolves to the documented default.
  const resolved = !requested ? DEFAULT_API_VERSION : normalizeVersion(requested);

  if (!resolved || !SUPPORTED_VERSIONS.includes(resolved)) {
    res.status(400).json({
      error: 'unsupported_version',
      supported: SUPPORTED_VERSIONS,
    });
    return;
  }

  req.apiVersion = resolved;
  // Echo the resolved version so clients can assert the served contract.
  res.setHeader(API_VERSION_RESPONSE_HEADER, resolved);
  next();
}
