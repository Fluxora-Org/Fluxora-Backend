/**
 * Deterministic race-condition tests for sendEarlyHints() in src/utils/earlyHints.ts
 *
 * Test strategy
 * ─────────────
 * `sendEarlyHints()` queues its write via `setImmediate()`.  That design means
 * there is an observable window between the outer `headersSent` guard (which
 * runs synchronously) and the inner guard (which runs inside the callback).
 *
 * We use `vi.useFakeTimers()` to freeze the micro-task / macro-task queue so
 * that we can mutate the response object *after* the call returns but *before*
 * the queued callback is flushed — making the race condition 100 % deterministic.
 *
 * Regression contract
 * ────────────────────
 * Test 1 ("Headers-already-sent race") will FAIL if the inner
 *   `if (!res.headersSent && resWithProcessing.writeProcessing)`
 * guard is removed or bypassed, because `writeProcessing` would then be called
 * on a response that has already committed.
 *
 * @module utils/earlyHints.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEarlyHints } from './earlyHints.js';
import type { EarlyHintsConfig } from './earlyHints.js';
import type { Response } from 'express';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Minimal mock of an Express `Response` that also carries the
 * `writeProcessing` method added by Node's HTTP/2 stack.
 *
 * We extend it with a plain setter so tests can simulate headers being
 * committed mid-flight without touching Express internals.
 */
interface MockResponse {
  headersSent: boolean;
  writeProcessing: ReturnType<typeof vi.fn>;
}

function createMockResponse(initialHeadersSent = false): MockResponse {
  return {
    headersSent: initialHeadersSent,
    writeProcessing: vi.fn(),
  };
}

/**
 * A minimal config that always passes all guards in `sendEarlyHints()`:
 * - `hasMore = true`
 * - a valid base64url cursor
 * - a relative base URL
 */
const VALID_CONFIG: EarlyHintsConfig = {
  baseUrl: '/api/streams',
  hasMore: true,
  nextCursor: 'abc123_DEF-456',
  queryParams: { status: 'active' },
};

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('sendEarlyHints()', () => {
  beforeEach(() => {
    // Freeze the event loop scheduler so setImmediate callbacks are NOT
    // executed until we explicitly flush them with vi.runAllTimers().
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Test 1: Headers-Already-Sent Race ─────────────────────────────────────

  describe('Test 1 – Headers-already-sent race (regression guard)', () => {
    it('does NOT call writeProcessing when headers are committed before the setImmediate callback fires', () => {
      const mockRes = createMockResponse(/* initialHeadersSent= */ false);

      // ① Call sendEarlyHints — outer guard passes because headersSent is false.
      //   The setImmediate callback is queued but NOT yet executed.
      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);

      // Verify writeProcessing has not been called yet (callback still queued).
      expect(mockRes.writeProcessing).not.toHaveBeenCalled();

      // ② Simulate the race: main response finishes before the queued callback
      //   gets a turn on the event loop.
      mockRes.headersSent = true;

      // ③ Now flush the queued setImmediate callback deterministically.
      vi.runAllTimers();

      // ④ The inner `!res.headersSent` guard must have prevented the call.
      //   If this assertion fails, the inner guard was removed or bypassed.
      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });

    it('does not throw when the response completes before the callback executes', () => {
      const mockRes = createMockResponse(false);

      expect(() => {
        sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
        mockRes.headersSent = true;
        vi.runAllTimers();
      }).not.toThrow();
    });
  });

  // ── Test 2: Successful Deferred Execution ──────────────────────────────────

  describe('Test 2 – Successful deferred execution (normal path)', () => {
    it('calls writeProcessing exactly once after the setImmediate callback fires', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);

      // Callback must still be queued at this point.
      expect(mockRes.writeProcessing).not.toHaveBeenCalled();

      // Flush the queued callback without mutating headersSent.
      vi.runAllTimers();

      expect(mockRes.writeProcessing).toHaveBeenCalledTimes(1);
    });

    it('passes "Link" as the header name to writeProcessing', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
      vi.runAllTimers();

      const [headerName] = mockRes.writeProcessing.mock.calls[0] as [string, string];
      expect(headerName).toBe('Link');
    });

    it('passes a correctly formatted RFC 8288 Link header value', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
      vi.runAllTimers();

      const [, linkValue] = mockRes.writeProcessing.mock.calls[0] as [string, string];

      // Must include the cursor and rel="next"
      expect(linkValue).toContain('cursor=abc123_DEF-456');
      expect(linkValue).toContain('rel="next"');

      // Must be wrapped in angle brackets as per RFC 8288
      expect(linkValue).toMatch(/^<.*>; rel="next"$/);
    });

    it('preserves extra queryParams in the Link header URL', () => {
      const mockRes = createMockResponse(false);
      const config: EarlyHintsConfig = {
        ...VALID_CONFIG,
        queryParams: { status: 'active', merchant: 'GABC123' },
      };

      sendEarlyHints(mockRes as unknown as Response, config);
      vi.runAllTimers();

      const [, linkValue] = mockRes.writeProcessing.mock.calls[0] as [string, string];
      expect(linkValue).toContain('status=active');
      expect(linkValue).toContain('merchant=GABC123');
    });
  });

  // ── Callback Invocation Count ─────────────────────────────────────────────

  describe('Callback invocation count', () => {
    it('queues the callback exactly once per sendEarlyHints() call', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
      vi.runAllTimers();

      // Regardless of how many timers are pending, writeProcessing fires once.
      expect(mockRes.writeProcessing).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire when runAllTimers is called a second time', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
      vi.runAllTimers();
      vi.runAllTimers(); // second flush — should be a no-op

      expect(mockRes.writeProcessing).toHaveBeenCalledTimes(1);
    });
  });

  // ── Outer headersSent Guard ───────────────────────────────────────────────

  describe('Outer headersSent guard (synchronous early return)', () => {
    it('does not queue a callback at all when headers are already sent on entry', () => {
      const mockRes = createMockResponse(/* initialHeadersSent= */ true);

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
      vi.runAllTimers();

      // writeProcessing should never be touched — not even scheduled.
      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });
  });

  // ── Config Guard Paths ────────────────────────────────────────────────────

  describe('Config guard: skips when no next page', () => {
    it('does not call writeProcessing when hasMore is false', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, { ...VALID_CONFIG, hasMore: false });
      vi.runAllTimers();

      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });

    it('does not call writeProcessing when nextCursor is null', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, { ...VALID_CONFIG, nextCursor: null });
      vi.runAllTimers();

      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });

    it('does not call writeProcessing when nextCursor is missing', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, { ...VALID_CONFIG, nextCursor: undefined });
      vi.runAllTimers();

      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });
  });

  // ── Cursor Validation ─────────────────────────────────────────────────────

  describe('Cursor safety validation', () => {
    it('does not call writeProcessing for a cursor with path-traversal characters', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, {
        ...VALID_CONFIG,
        nextCursor: '../../../etc/passwd',
      });
      vi.runAllTimers();

      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });

    it('does not call writeProcessing for a cursor containing spaces', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, {
        ...VALID_CONFIG,
        nextCursor: 'bad cursor!',
      });
      vi.runAllTimers();

      expect(mockRes.writeProcessing).not.toHaveBeenCalled();
    });

    it('calls writeProcessing for a valid base64url cursor containing hyphens and underscores', () => {
      const mockRes = createMockResponse(false);

      sendEarlyHints(mockRes as unknown as Response, {
        ...VALID_CONFIG,
        nextCursor: 'valid-cursor_123',
      });
      vi.runAllTimers();

      expect(mockRes.writeProcessing).toHaveBeenCalledTimes(1);
    });
  });

  // ── writeProcessing Absent ────────────────────────────────────────────────

  describe('Graceful degradation when writeProcessing is not available', () => {
    it('does not throw when the response object lacks writeProcessing', () => {
      // Simulate HTTP/1.0 client or a proxy that does not support 1xx.
      const minimalRes = { headersSent: false } as unknown as Response;

      expect(() => {
        sendEarlyHints(minimalRes, VALID_CONFIG);
        vi.runAllTimers();
      }).not.toThrow();
    });
  });

  // ── Error Handling Inside the Callback ───────────────────────────────────

  describe('Error handling inside the deferred callback', () => {
    it('does not throw when writeProcessing itself throws', () => {
      const mockRes = createMockResponse(false);
      mockRes.writeProcessing.mockImplementation(() => {
        throw new Error('socket hang up');
      });

      expect(() => {
        sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
        vi.runAllTimers();
      }).not.toThrow();
    });

    it('calls writeProcessing exactly once even when it throws', () => {
      const mockRes = createMockResponse(false);
      mockRes.writeProcessing.mockImplementation(() => {
        throw new Error('write error');
      });

      sendEarlyHints(mockRes as unknown as Response, VALID_CONFIG);
      vi.runAllTimers();

      // Should have been attempted once; error is swallowed internally.
      expect(mockRes.writeProcessing).toHaveBeenCalledTimes(1);
    });
  });

  // ── Multiple Concurrent Calls ─────────────────────────────────────────────

  describe('Multiple concurrent sendEarlyHints() calls', () => {
    it('each call independently queues its own callback', () => {
      const mockRes1 = createMockResponse(false);
      const mockRes2 = createMockResponse(false);

      sendEarlyHints(mockRes1 as unknown as Response, VALID_CONFIG);
      sendEarlyHints(mockRes2 as unknown as Response, VALID_CONFIG);

      vi.runAllTimers();

      expect(mockRes1.writeProcessing).toHaveBeenCalledTimes(1);
      expect(mockRes2.writeProcessing).toHaveBeenCalledTimes(1);
    });

    it('race on res1 does not affect res2 execution', () => {
      const mockRes1 = createMockResponse(false);
      const mockRes2 = createMockResponse(false);

      sendEarlyHints(mockRes1 as unknown as Response, VALID_CONFIG);
      sendEarlyHints(mockRes2 as unknown as Response, VALID_CONFIG);

      // Commit res1 mid-flight; res2 remains open.
      mockRes1.headersSent = true;

      vi.runAllTimers();

      expect(mockRes1.writeProcessing).not.toHaveBeenCalled();
      expect(mockRes2.writeProcessing).toHaveBeenCalledTimes(1);
    });
  });
});
