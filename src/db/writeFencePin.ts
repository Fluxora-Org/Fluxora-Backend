/**
 * Write-fence pin: a short-lived, HMAC-SHA256–signed token that instructs
 * downstream read routing to use the **primary** pool for a bounded window
 * after a write, solving the classic "read-your-writes" hazard that arises
 * when reads are spread across replica pools that may lag the primary.
 *
 * ## Protocol
 *
 * ```
 * POST /api/streams          → server issues  X-Fluxora-Write-Fence: <pin>
 * GET  /api/streams?cursor=… → client echoes  X-Fluxora-Write-Fence: <pin>
 *                              server verifies and routes to primary if valid
 * ```
 *
 * ## Pin format
 *
 * ```
 * <pin> = base64url( "v1" + "." + <ts_ms> + "." + <sig> )
 *
 * where
 *   ts_ms = Unix epoch in **milliseconds** (string digits)
 *   sig   = hex-encoded HMAC-SHA256( key, "v1:" + ts_ms )
 * ```
 *
 * A version prefix ("v1") is embedded so future algorithm migrations
 * can be deployed without breaking in-flight tokens.
 *
 * ## Security properties
 *
 * - **Integrity**: HMAC-SHA256 prevents forgery without the server secret.
 * - **Replay resistance**: the timestamp inside the pin is verified against
 *   `RYW_PIN_TTL_SECONDS` (default 30 s).  An expired pin is simply ignored
 *   and the request falls back to normal replica routing — no error is raised.
 * - **Constant-time comparison**: signature verification uses
 *   `crypto.timingSafeEqual` to prevent timing-oracle attacks.
 * - **Key material**: the first 32 bytes of `JWT_SECRET` are used as the
 *   HMAC key.  `JWT_SECRET` is already required to be ≥ 32 characters by the
 *   env schema, so no additional configuration is needed.
 * - **Stateless**: no server-side storage is required.  Expiry is enforced
 *   purely through the timestamp inside the signed payload.
 *
 * ## TTL
 *
 * The TTL is read from `RYW_PIN_TTL_SECONDS` at verification time (not
 * module load) so it can be changed without a restart in environments that
 * support live env-var updates.  Default: **30 seconds**.  Setting it to
 * `0` disables pin enforcement entirely (all reads go to replica/primary per
 * normal routing).
 *
 * @module db/writeFencePin
 */

import crypto from 'crypto';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Header name on both request (client echoes pin) and response (server issues pin). */
export const WRITE_FENCE_HEADER = 'X-Fluxora-Write-Fence' as const;

/**
 * Default pin lifetime in seconds.
 * After this window, the pin is silently discarded and normal replica routing
 * applies.  30 s is generous for most replica lag configurations.
 */
const DEFAULT_TTL_SECONDS = 30;

/** Protocol version embedded at the start of every pin. */
const PIN_VERSION = 'v1' as const;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read `RYW_PIN_TTL_SECONDS` from the environment at call-time.
 * Returns the default (30 s) for unset / non-numeric values; 0 when
 * explicitly set to `"0"` (disables pinning).
 */
function readTtlSeconds(): number {
  const raw = process.env['RYW_PIN_TTL_SECONDS'];
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_SECONDS;
}

/**
 * Derive a 32-byte signing key from `JWT_SECRET`.
 *
 * We take the first 32 bytes of the UTF-8 encoded secret rather than using
 * the full secret so the key length is fixed regardless of how long
 * `JWT_SECRET` happens to be.  A fixed-length key is required for a
 * constant-time comparison of signatures.
 *
 * @throws {Error} When `JWT_SECRET` is absent or shorter than 32 characters.
 */
function deriveSigningKey(): Buffer {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be set and be at least 32 characters long to issue write-fence pins',
    );
  }
  // Take the raw UTF-8 bytes of the first 32 characters.
  return Buffer.from(secret, 'utf8').subarray(0, 32);
}

/**
 * Compute `HMAC-SHA256(key, message)` and return the hex digest.
 */
function hmac(key: Buffer, message: string): string {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Issue a new write-fence pin stamped with the current wall-clock time.
 *
 * The returned string is safe to embed in an HTTP header value — it is
 * base64url-encoded, containing only `[A-Za-z0-9_-]`.
 *
 * @returns base64url-encoded signed pin.
 * @throws {Error} When `JWT_SECRET` is missing or too short.
 *
 * @example
 * ```typescript
 * import { issueWriteFencePin, WRITE_FENCE_HEADER } from '../db/writeFencePin.js';
 *
 * const pin = issueWriteFencePin();
 * res.set(WRITE_FENCE_HEADER, pin);
 * ```
 */
export function issueWriteFencePin(): string {
  const key = deriveSigningKey();
  const tsMs = Date.now().toString(10);
  const message = `${PIN_VERSION}:${tsMs}`;
  const sig = hmac(key, message);
  const raw = `${PIN_VERSION}.${tsMs}.${sig}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Verify a write-fence pin received in an incoming request header.
 *
 * Returns `true` when the pin is cryptographically valid **and** has not
 * expired.  Returns `false` for any invalid, malformed, expired, or missing
 * pin — callers should treat a `false` result as "use normal routing" rather
 * than as an error.
 *
 * **Timing safety**: signature comparison uses `crypto.timingSafeEqual` so
 * the function does not leak key material through response timing.
 *
 * @param pinHeader - Raw header value from `req.headers[WRITE_FENCE_HEADER]`.
 *   May be `undefined` or an array (Express normalises multi-value headers to
 *   a single string, but we guard against arrays defensively).
 * @returns `true` if the pin is valid and still within TTL.
 *
 * @example
 * ```typescript
 * import { verifyWriteFencePin, WRITE_FENCE_HEADER } from '../db/writeFencePin.js';
 *
 * const pin = req.headers[WRITE_FENCE_HEADER.toLowerCase()];
 * if (verifyWriteFencePin(pin)) {
 *   // Route this read to the primary pool
 * }
 * ```
 */
export function verifyWriteFencePin(
  pinHeader: string | string[] | undefined,
): boolean {
  // Guard against absent / multi-value headers.
  if (!pinHeader) return false;
  const raw = Array.isArray(pinHeader) ? pinHeader[0] : pinHeader;
  if (typeof raw !== 'string' || raw.trim() === '') return false;

  // Decode base64url → "v1.<ts_ms>.<sig>"
  let decoded: string;
  try {
    decoded = Buffer.from(raw.trim(), 'base64url').toString('utf8');
  } catch {
    return false;
  }

  // Parse components
  const parts = decoded.split('.');
  if (parts.length !== 3) return false;

  const [version, tsMs, receivedSig] = parts;

  if (version !== PIN_VERSION) return false;
  if (!tsMs || !/^\d{10,}$/.test(tsMs)) return false; // must be ≥10 digits (ms epoch)
  if (!receivedSig || receivedSig.length === 0) return false;

  // Validate timestamp (TTL check before HMAC to short-circuit early)
  const ttlSeconds = readTtlSeconds();
  if (ttlSeconds === 0) return false; // pinning explicitly disabled

  const issuedAt = parseInt(tsMs, 10);
  const ageMs = Date.now() - issuedAt;
  if (ageMs < 0 || ageMs > ttlSeconds * 1000) return false;

  // Derive expected signature
  let key: Buffer;
  try {
    key = deriveSigningKey();
  } catch {
    return false;
  }

  const expectedSig = hmac(key, `${PIN_VERSION}:${tsMs}`);

  // Constant-time comparison to prevent timing oracles.
  // Both buffers must be the same length (hex HMAC-SHA256 is always 64 chars).
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const receivedBuf = Buffer.from(receivedSig, 'hex');

  if (expectedBuf.length !== receivedBuf.length) return false;

  try {
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

/**
 * Parse the `X-Fluxora-Write-Fence` request header and return whether the
 * current request carries a **valid, unexpired** write-fence pin.
 *
 * This is a convenience wrapper around {@link verifyWriteFencePin} that
 * accepts the raw Express `req.headers` object.
 *
 * @param headers - `req.headers` from an Express `Request`.
 * @returns `true` when the request should be routed to the primary pool.
 */
export function shouldForcePrimaryFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const header = headers[WRITE_FENCE_HEADER.toLowerCase()];
  return verifyWriteFencePin(header);
}
