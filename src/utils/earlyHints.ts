/**
 * HTTP 103 Early Hints support for pagination link preloading.
 *
 * Allows sending Link headers (rel="next", rel="prev") via 103 informational
 * responses before the main response, enabling HTTP/2 clients to prefetch
 * DNS and TLS for pagination URIs while the server is still computing the
 * current page.
 *
 * Design principles:
 * - Graceful degradation: clients that don't support 1xx responses (HTTP/1.0,
 *   some proxies) transparently ignore Early Hints — no functional regression.
 * - Non-blocking: Early Hints are queued asynchronously and must not delay
 *   time-to-first-byte of the main response.
 * - Security: only sends predictable, validated URLs (pagination cursors).
 * - Simplicity: integrates cleanly with Express and Stellar pagination model.
 *
 * RFC 8297 (Early Hints) specifies that:
 * - Informational (1xx) responses must appear before the final response.
 * - Early Hints may be safely ignored by clients / proxies / intermediaries.
 * - The main response MUST be sent within a reasonable time after Early Hints.
 *
 * @module utils/earlyHints
 */

import type { IncomingMessage } from 'node:http';
import type { Request, Response } from 'express';
import { debug, warn } from './logger.js';
import { getConfig } from '../config/env.js';

/**
 * Standard HTTP request header used by clients to advertise support for HTTP 103 Early Hints.
 */
export const EARLY_HINTS_HEADER = 'early-hints';

/**
 * Helper to extract a header string value safely across Express Request and raw Node IncomingMessage.
 */
function getHeaderValue(req: Request | IncomingMessage, name: string): string | undefined {
  if (typeof (req as Request).header === 'function') {
    const val = (req as Request).header(name);
    if (val !== undefined) return val;
  }
  const val = req.headers?.[name.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return val;
}

/**
 * Determine whether a client advertises support for HTTP 103 Early Hints.
 *
 * Early hints are an optimization. Sending 1xx informational responses to clients
 * or intermediaries that do not understand them can cause connection drops or protocol
 * framing errors.
 *
 * A client advertises support by sending one of the following request headers:
 * - `Early-Hints: 1` (or `true`)
 * - `X-Early-Hints: 1` (or `true`)
 * - `Accept-Early-Hints: 1` (or `true`)
 *
 * @param req - Express Request or Node.js IncomingMessage
 * @returns true if the client explicitly advertised support for Early Hints
 */
export function clientSupportsEarlyHints(req?: Request | IncomingMessage): boolean {
  if (!req) return false;

  const values = [
    getHeaderValue(req, 'early-hints'),
    getHeaderValue(req, 'x-early-hints'),
    getHeaderValue(req, 'accept-early-hints'),
  ];

  return values.some(
    (v) => v !== undefined && (v === '1' || v.toLowerCase() === 'true')
  );
}

/**
 * Helper to check whether Early Hints is globally enabled in config.
 * Falls back to process.env.EARLY_HINTS_ENABLED if getConfig() is not yet initialized.
 */
export function isEarlyHintsConfigEnabled(): boolean {
  if (
    process.env['EARLY_HINTS_ENABLED'] === 'false' ||
    process.env['EARLY_HINTS_ENABLED'] === '0' ||
    process.env['ENABLE_EARLY_HINTS'] === 'false' ||
    process.env['ENABLE_EARLY_HINTS'] === '0'
  ) {
    return false;
  }

  try {
    return getConfig().earlyHintsEnabled;
  } catch {
    return true;
  }
}

/**
 * Configuration for Early Hints generation.
 */
export interface EarlyHintsConfig {
  /** Base URL for building pagination links (e.g., 'https://api.example.com/api/streams') */
  baseUrl: string;
  /** Whether the response will have a next page. */
  hasMore: boolean;
  /** Opaque cursor token for the next page (base64url-encoded). */
  nextCursor?: string | null;
  /** Query parameters to preserve in pagination links (e.g., status, sender). */
  queryParams?: Record<string, string>;
  /** Maximum number of Link headers to send in Early Hints (advisory). */
  maxLinks?: number;
  /**
   * Explicit override for client support check (e.g., for testing or programmatic control).
   * When specified, overrides inspecting request headers.
   */
  clientSupportsHints?: boolean;
  /**
   * Explicit override for enabling/disabling Early Hints.
   * When specified, overrides global EARLY_HINTS_ENABLED configuration.
   */
  enabled?: boolean;
}

/**
 * Build a Link header value following RFC 8288 (Web Linking).
 *
 * Example output: `</api/streams?cursor=abc&limit=50>; rel="next"`
 *
 * @param url - the target URL (absolute or relative)
 * @param rel - link relation type (e.g., "next", "prev", "first")
 * @returns formatted Link header value
 */
export function buildLinkHeader(url: string, rel: string): string {
  return `<${url}>; rel="${rel}"`;
}

/**
 * Build a pagination URL with query parameters.
 *
 * Safely constructs a URL with query params, handling both relative and
 * absolute base URLs. All parameters are properly URL-encoded.
 *
 * @param baseUrl - base URL (e.g., '/api/streams' or 'https://api.example.com/api/streams')
 * @param params - query parameters as key-value pairs
 * @returns complete URL with query string
 */
export function buildPaginationUrl(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl, 'http://example.com'); // dummy origin for relative URL parsing
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  const urlStr = url.toString();
  // Return relative URL if baseUrl was relative, absolute otherwise
  return baseUrl.startsWith('http') ? urlStr : urlStr.replace('http://example.com', '');
}

/**
 * Validate that a cursor is a safe, opaque token (base64url string).
 *
 * Cursors should only contain alphanumeric, '-', and '_' characters
 * (base64url alphabet). This prevents injection attacks.
 *
 * @param cursor - the cursor string to validate
 * @returns true if the cursor appears to be a valid opaque token
 */
export function isSafeCursor(cursor: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(cursor);
}

/**
 * Send HTTP 103 Early Hints with Link headers for pagination.
 *
 * This function does NOT block the main response. The Early Hints are
 * written asynchronously via res.writeProcessing() (Node.js HTTP2 / HTTP/1.1
 * with Express support). If the response has already started or the feature
 * is not supported, this function silently degrades.
 *
 * Design:
 * - Checks if the client supports HTTP/2 or HTTP/1.1 with Early Hints
 * - Builds a Link header for the next page (if hasMore && nextCursor provided)
 * - Writes the 103 response without waiting or blocking the current handler
 * - Returns immediately; main response is sent normally by the handler
 *
 * Security:
 * - Validates cursor format (base64url only)
 * - Only sends URLs within the same API endpoint
 * - Query parameters are validated and URL-encoded
 *
 * @param res - Express response object
 * @param config - configuration including base URL, cursor, and query params
 * @returns void (fire-and-forget; never throws)
 */
export function sendEarlyHints(res: Response, config: EarlyHintsConfig): void {
  try {
    // Early return: if response has started, we cannot send informational responses
    if (res.headersSent) {
      debug('Early Hints: response already started, skipping 103');
      return;
    }

    // Early return: if no next page, nothing to hint
    if (!config.hasMore || !config.nextCursor) {
      debug('Early Hints: no next page or cursor, skipping');
      return;
    }

    // Validate cursor format to prevent injection
    if (!isSafeCursor(config.nextCursor)) {
      warn('Early Hints: unsafe cursor format, skipping', { cursor: config.nextCursor });
      return;
    }

    // Build the next page URL
    const nextParams: Record<string, string> = {
      cursor: config.nextCursor,
      limit: '50', // default limit (matches the main response)
      ...config.queryParams,
    };
    const nextUrl = buildPaginationUrl(config.baseUrl, nextParams);
    const linkHeader = buildLinkHeader(nextUrl, 'next');

    // Check if the response object supports writeProcessing (HTTP/2 or modern HTTP/1.1)
    // writeProcessing is the underlying mechanism for sending 1xx responses.
    const resWithProcessing = res as unknown as { writeProcessing?: (header: string, value: string) => void };
    if (typeof resWithProcessing.writeProcessing === 'function') {
      // Attempt to send the Early Hints asynchronously without blocking
      setImmediate(() => {
        try {
          if (!res.headersSent && resWithProcessing.writeProcessing) {
            resWithProcessing.writeProcessing('Link', linkHeader);
            debug('Early Hints: sent 103 with Link header', {
              linkHeader,
              nextUrl,
            });
          }
        } catch (err) {
          // Silently ignore errors sending Early Hints — they are informational
          // and should never cause the main response to fail.
          debug('Early Hints: failed to send 103', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    } else {
      debug('Early Hints: writeProcessing not available, skipping');
    }
  } catch (err) {
    // Outer catch to ensure this utility never throws — Early Hints are
    // best-effort and must not interfere with the main response.
    warn('Early Hints: unexpected error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send Early Hints for pagination with multiple link relations.
 *
 * Advanced version that can send both "next" and "prev" links if cursors
 * are available. Useful for bi-directional pagination scenarios.
 *
 * @param res - Express response object
 * @param baseUrl - base URL for pagination links
 * @param hasMore - whether a next page exists
 * @param nextCursor - opaque cursor for the next page
 * @param prevCursor - opaque cursor for the previous page (optional)
 * @param queryParams - query parameters to preserve
 * @returns void
 */
export function sendEarlyHintsWithBoth(
  res: Response,
  baseUrl: string,
  hasMore: boolean,
  nextCursor?: string | null,
  prevCursor?: string | null,
  queryParams?: Record<string, string>,
): void {
  try {
    if (res.headersSent) return;

    const links: string[] = [];

    if (hasMore && nextCursor && isSafeCursor(nextCursor)) {
      const nextParams = { cursor: nextCursor, limit: '50', ...queryParams };
      const nextUrl = buildPaginationUrl(baseUrl, nextParams);
      links.push(buildLinkHeader(nextUrl, 'next'));
    }

    if (prevCursor && isSafeCursor(prevCursor)) {
      const prevParams = { cursor: prevCursor, limit: '50', ...queryParams };
      const prevUrl = buildPaginationUrl(baseUrl, prevParams);
      links.push(buildLinkHeader(prevUrl, 'prev'));
    }

    if (links.length === 0) return;

    const resWithProcessing = res as unknown as { writeProcessing?: (header: string, value: string) => void };
    if (typeof resWithProcessing.writeProcessing === 'function') {
      setImmediate(() => {
        try {
          const writeProcessing = resWithProcessing.writeProcessing;
          if (!res.headersSent && writeProcessing) {
            links.forEach((linkHeader) => {
              writeProcessing('Link', linkHeader);
            });
            debug('Early Hints: sent 103 with multiple Link headers', {
              linkCount: links.length,
            });
          }
        } catch (err) {
          debug('Early Hints: failed to send 103', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  } catch (err) {
    warn('Early Hints (multi): unexpected error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
