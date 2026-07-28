import type { Request, Response, NextFunction } from 'express';

/** Canonical header name used for versioning. */
export const ACCEPT_VERSION_HEADER = 'accept-version';

/** Supported API versions. */
const SUPPORTED_VERSIONS = ['v1'];

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
 * If absent, it defaults to the latest stable version ("v1").
 * If present but unsupported, it short-circuits the request with a 400 response.
 *
 * The resolved and validated version is attached to `req.apiVersion`.
 */
export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rawHeader = req.headers[ACCEPT_VERSION_HEADER];
  
  // Handle array of headers by taking the first one
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  // Default to v1 if header is absent or empty
  if (!headerValue || headerValue.trim() === '') {
    req.apiVersion = 'v1';
    return next();
  }

  const normalized = normalizeVersion(headerValue);

  if (!normalized || !SUPPORTED_VERSIONS.includes(normalized)) {
    res.status(400).json({
      error: 'unsupported_version',
      supported: SUPPORTED_VERSIONS
    });
    return;
  }

  req.apiVersion = normalized;
  next();
}
