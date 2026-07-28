/**
 * Idempotency key generation and payload hashing utilities.
 *
 * Generated from `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
 * Do not edit by hand — run `pnpm generate:sdk:ts` instead.
 *
 * ## Purpose
 * POST /api/streams requires an `Idempotency-Key` header to prevent duplicate
 * stream creation on retries. This module provides:
 *
 * - `generateIdempotencyKey()` — creates a fresh UUID v4 key per operation.
 * - `canonicalizeBody()` — serialises an object to a deterministic JSON string
 *   (sorted keys, recursive) suitable for hashing.
 * - `hashBody()` — computes a SHA-256 hex digest matching the server-side
 *   `fingerprintInput()` in `src/routes/streams.ts`.
 *
 * ## Security
 * - Keys are generated with `crypto.randomUUID()` (WebCrypto) where available,
 *   with a `Math.random`-based UUID v4 fallback for older environments.
 * - `hashBody()` uses `crypto.subtle.digest` (WebCrypto) with a Node.js
 *   `node:crypto` `createHash` fallback.
 * - Key values are never logged or echoed in error responses.
 *
 * @module @fluxora/sdk/idempotency
 */

// ── Key Generation ────────────────────────────────────────────────────────────

/**
 * Generate a unique UUID v4 idempotency key.
 *
 * Uses `crypto.randomUUID()` (Node.js ≥ 15, all modern browsers).
 * Falls back to a `Math.random`-based v4 UUID for older environments.
 *
 * Generate a **new key per logical operation**. Reuse the same key when
 * retrying a failed request to make it idempotent.
 *
 * @returns A UUID v4 string (e.g. `'b4a6f1a2-33c9-4d8e-b789-0e0a1c2d3e4f'`).
 *
 * @example
 * ```typescript
 * const key = generateIdempotencyKey();
 * const stream = await client.createStream(input, key);
 * // Retry with same key — gets cached response
 * const same = await client.createStream(input, key);
 * ```
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Math.random fallback for environments without WebCrypto
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Canonical JSON ────────────────────────────────────────────────────────────

/**
 * Recursively serialise a value to a **canonical** JSON string.
 *
 * Canonical form guarantees that two logically equal objects always produce
 * the same string regardless of key insertion order, enabling deterministic
 * payload fingerprinting that matches the server-side `fingerprintInput()`.
 *
 * Rules:
 * - Object keys are sorted lexicographically (ascending, recursive).
 * - Array element order is preserved.
 * - Primitives are serialised as `JSON.stringify` would.
 * - `null` and `undefined` are both serialised as `'null'`.
 *
 * @param body - Any JSON-serialisable value.
 * @returns A deterministic JSON string.
 *
 * @example
 * ```typescript
 * canonicalizeBody({ z: 1, a: 2 }); // '{"a":2,"z":1}'
 * canonicalizeBody({ a: 2, z: 1 }); // '{"a":2,"z":1}'  — identical
 * ```
 */
export function canonicalizeBody(body: unknown): string {
  if (body === null || body === undefined) return 'null';
  if (typeof body !== 'object') return JSON.stringify(body);

  if (Array.isArray(body)) {
    const items = (body as unknown[]).map((item) => canonicalizeBody(item));
    return `[${items.join(',')}]`;
  }

  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `"${k}":${canonicalizeBody(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

// ── SHA-256 Hashing ───────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of a JSON payload.
 *
 * The payload is canonicalised via `canonicalizeBody()` and UTF-8 encoded
 * before hashing. The digest matches the server-side `fingerprintInput()`
 * in `src/routes/streams.ts`.
 *
 * Prefers `crypto.subtle.digest` (WebCrypto) with a Node.js
 * `node:crypto` `createHash` fallback.
 *
 * @param body - Any JSON-serialisable value.
 * @returns A lowercase 64-character SHA-256 hex string.
 * @throws {Error} When no crypto API is available.
 *
 * @example
 * ```typescript
 * const hash = await hashBody({ sender: 'G...', depositAmount: '100' });
 * console.log(hash.length); // 64
 * ```
 */
export async function hashBody(body: unknown): Promise<string> {
  const canonical = canonicalizeBody(body);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Node.js crypto fallback for environments without globalThis.crypto
  try {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    throw new Error('Crypto API unavailable: cannot compute SHA-256 hash');
  }
}
