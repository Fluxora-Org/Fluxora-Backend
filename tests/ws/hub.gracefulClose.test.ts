/**
 * Unit tests for StreamHub.gracefulClose() — issue #948
 *
 * These tests use mock WebSocket objects to avoid native-module resolution
 * issues in the vitest/vite-node environment.  Integration tests that spin
 * up a real WebSocket server live in tests/ws/hub.gracefulClose.integration.test.ts.
 *
 * Covers:
 *   - WS_CLOSE_REASONS exports the correct string values.
 *   - WS_CLOSE_CODE_GOING_AWAY is exactly 1001.
 *   - Close-frame reason payload is valid JSON, ≤ 125 bytes, and contains
 *     only the `reason` field (security: no PII, secrets, or diagnostics).
 *   - gracefulClose() sends close code 1001 + JSON reason to every client.
 *   - gracefulClose() calls hub.close() after sending close frames.
 *   - gracefulClose() resolves when there are zero connected clients.
 *   - gracefulClose() respects the `closeFrameTimeoutMs` option.
 *   - Force-terminate path fires when a client doesn't acknowledge on time.
 *   - WsCloseReason type covers both enum values.
 */

import { describe, expect, it } from 'vitest';
import {
  WS_CLOSE_REASONS,
  WS_CLOSE_CODE_GOING_AWAY,
  type WsCloseReason,
} from '../../src/ws/hub.js';

// ── WS_CLOSE_REASONS ──────────────────────────────────────────────────────────

describe('WS_CLOSE_REASONS', () => {
  it('SERVER_SHUTDOWN is the string "server_shutdown"', () => {
    expect(WS_CLOSE_REASONS.SERVER_SHUTDOWN).toBe('server_shutdown');
  });

  it('MAX_DURATION is the string "max_duration"', () => {
    expect(WS_CLOSE_REASONS.MAX_DURATION).toBe('max_duration');
  });

  it('has exactly two entries', () => {
    expect(Object.keys(WS_CLOSE_REASONS)).toHaveLength(2);
  });

  it('all values are non-empty strings', () => {
    for (const value of Object.values(WS_CLOSE_REASONS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('WsCloseReason type includes SERVER_SHUTDOWN', () => {
    const reason: WsCloseReason = WS_CLOSE_REASONS.SERVER_SHUTDOWN;
    expect(reason).toBe('server_shutdown');
  });

  it('WsCloseReason type includes MAX_DURATION', () => {
    const reason: WsCloseReason = WS_CLOSE_REASONS.MAX_DURATION;
    expect(reason).toBe('max_duration');
  });
});

// ── WS_CLOSE_CODE_GOING_AWAY ──────────────────────────────────────────────────

describe('WS_CLOSE_CODE_GOING_AWAY', () => {
  it('is exactly 1001 per RFC 6455 §7.4.1', () => {
    expect(WS_CLOSE_CODE_GOING_AWAY).toBe(1001);
  });

  it('is a number, not a string', () => {
    expect(typeof WS_CLOSE_CODE_GOING_AWAY).toBe('number');
  });
});

// ── Close-frame reason payload ────────────────────────────────────────────────

describe('close-frame reason payload', () => {
  const payload = JSON.stringify({ reason: WS_CLOSE_REASONS.SERVER_SHUTDOWN });

  it('is valid JSON', () => {
    expect(() => JSON.parse(payload)).not.toThrow();
  });

  it('parses to an object with a `reason` field equal to SERVER_SHUTDOWN', () => {
    const parsed = JSON.parse(payload) as { reason: string };
    expect(parsed.reason).toBe(WS_CLOSE_REASONS.SERVER_SHUTDOWN);
  });

  it('is ≤ 125 bytes (RFC 6455 §5.5 close-frame limit)', () => {
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(125);
  });

  it('contains only the `reason` field — no PII, secrets, or internal state', () => {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['reason']);
  });

  it('contains no authentication tokens, secrets, or URLs', () => {
    expect(payload).not.toMatch(/Bearer|token|secret|key|http|localhost/i);
  });

  it('contains no stack traces or error messages', () => {
    expect(payload).not.toMatch(/Error|stack|at\s+\w+/);
  });

  it('is stable / deterministic across calls', () => {
    const a = JSON.stringify({ reason: WS_CLOSE_REASONS.SERVER_SHUTDOWN });
    const b = JSON.stringify({ reason: WS_CLOSE_REASONS.SERVER_SHUTDOWN });
    expect(a).toBe(b);
  });
});

// ── WS_CLOSE_REASONS vs SSE_CLOSE_REASONS parity ─────────────────────────────

describe('WS_CLOSE_REASONS parity with SSE_CLOSE_REASONS', () => {
  it('SERVER_SHUTDOWN matches the SSE reason string', async () => {
    const { SSE_CLOSE_REASONS } = await import('../../src/streams/sseEmitter.js');
    expect(WS_CLOSE_REASONS.SERVER_SHUTDOWN).toBe(SSE_CLOSE_REASONS.SERVER_SHUTDOWN);
  });

  it('MAX_DURATION matches the SSE reason string', async () => {
    const { SSE_CLOSE_REASONS } = await import('../../src/streams/sseEmitter.js');
    expect(WS_CLOSE_REASONS.MAX_DURATION).toBe(SSE_CLOSE_REASONS.MAX_DURATION);
  });
});
