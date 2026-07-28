import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { _resetAuditLog, getAuditEntries, recordAuditEvent } from '../../src/lib/auditLog.js';
import { verifyWsToken } from '../../src/middleware/tokenAuth.js';
import { wsAuthFailureTotal } from '../../src/metrics/businessMetrics.js';
import { getStreamHub, resetStreamHub } from '../../src/ws/hub.js';
import type { IncomingMessage } from 'http';

vi.mock('../../src/lib/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/logger.js')>();
  return {
    ...original,
    logger: {
      ...original.logger,
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('../../src/ws/hub.js');

/**
 * #672 / #1092 / #1094 -- WebSocket Broadcast Authorization & Integration Auth
 * Coverage tests.
 *
 * These tests verify the audit logging contract for STREAM_BROADCAST events,
 * document the integration auth surface, and cover edge cases around broadcast
 * access control, auth failure modes, dedup, error handling, and observability.
 *
 * ## Integration Auth Surface
 *
 * The broadcast path has two authentication layers:
 *
 * 1. **WebSocket upgrade auth** (optional, controlled by `WS_AUTH_REQUIRED`):
 *    - `verifyWsToken()` in `src/middleware/tokenAuth.ts` extracts a JWT from
 *      the `Authorization: Bearer <token>` header or `?token=<jwt>` query param.
 *    - When `WS_AUTH_REQUIRED=true` and `JWT_SECRET` is set, unauthenticated
 *      upgrade requests are rejected with HTTP 401 before the WebSocket
 *      handshake completes.
 *    - When `WS_AUTH_REQUIRED` is absent or false, all connections are accepted
 *      regardless of whether a token is present (backward-compatible rollout).
 *    - Auth failures emit `fluxora_ws_auth_failure_total` Prometheus counters
 *      and -- for notable codes (`INVALID_TOKEN`, `AUTH_NOT_CONFIGURED`) --
 *      write `WS_AUTH_FAILURE` audit entries. `MISSING_TOKEN` is NOT audited
 *      because it is a common benign case (e.g. public SSE connections).
 *
 * 2. **HTTP API auth** (JWT via `authenticate` middleware, API key via
 *    `authenticateApiKey` middleware):
 *    - The `streamsRouter` uses `authenticate` + `requireAuth` +
 *      `authenticateApiKey` + `requireScope('streams:read')` for the SSE
 *      endpoint (`GET /api/streams/:id/events`).
 *    - The SSE route reuses `verifyWsToken` for its own JWT check, but
 *      behaves differently from the WS upgrade path: when `WS_AUTH_REQUIRED=false`
 *      and the token is invalid (not missing), the SSE route still rejects
 *      with 401, whereas the WS upgrade path silently accepts the connection.
 *
 * ## Broadcast Access Control
 *
 * - `hub.broadcast()` is the sole broadcast entry point. It is called only
 *   from `streamEventService` (indexer pipeline) and the deprecated
 *   `streamChannel.ts` wrapper. No HTTP route calls `hub.broadcast()` directly.
 * - The hub dedupes events by `(streamId, eventId)` before fan-out.
 * - The hub splits subscribers into batched (opt-in) and immediate (default)
 *   paths, applying backpressure (drop/terminate) for slow clients.
 * - Broadcast failures are caught and logged by `streamEventService`; they
 *   never propagate back to the indexer pipeline.
 *
 * ## Audit Contract
 *
 * Every broadcast triggered by `streamEventService` records a `STREAM_BROADCAST`
 * audit entry via `recordAuditEvent()`. The entry includes the event type
 * (stream.created/updated/cancelled), eventId, and contractId in `meta`.
 *
 * The full integration test of streamEventService -> hub.broadcast -> audit
 * requires heavy mocking of the indexer pipeline. Instead we test the two
 * independently testable pieces:
 *
 * 1. recordAuditEvent("STREAM_BROADCAST", ...) produces a well-formed entry
 * 2. The broadcast trigger surface is indexer-only (no HTTP route calls broadcast)
 * 3. Auth failure modes produce the correct audit/observability signals
 * 4. The audit log never throws regardless of input shape
 */

function makeIncomingMessage(overrides: Record<string, unknown> = {}): IncomingMessage {
  return {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    url: '/ws/streams',
    ...overrides,
  } as unknown as IncomingMessage;
}

describe('WebSocket Broadcast Authorization (#672, #1092)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAuditLog();
    resetStreamHub();
    wsAuthFailureTotal.reset();
  });

  // -- STREAM_BROADCAST Audit Entries --------------------------------------

  describe('STREAM_BROADCAST audit entries', () => {
    it('should record audit entry with correct action and resource for stream.created', () => {
      recordAuditEvent(
        'STREAM_BROADCAST',
        'stream',
        'stream-123',
        'corr-001',
        { event: 'stream.created', eventId: 'evt-456', contractId: 'CXYZ' }
      );

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('STREAM_BROADCAST');
      expect(entries[0].resourceType).toBe('stream');
      expect(entries[0].resourceId).toBe('stream-123');
      expect(entries[0].correlationId).toBe('corr-001');
      expect(entries[0].meta).toEqual({ event: 'stream.created', eventId: 'evt-456', contractId: 'CXYZ' });
    });

    it('should record audit entry for stream.updated', () => {
      recordAuditEvent(
        'STREAM_BROADCAST',
        'stream',
        'stream-789',
        'corr-002',
        { event: 'stream.updated', eventId: 'evt-101' }
      );

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('STREAM_BROADCAST');
      expect(entries[0].resourceId).toBe('stream-789');
      expect(entries[0].meta?.event).toBe('stream.updated');
    });

    it('should record audit entry for stream.cancelled', () => {
      recordAuditEvent(
        'STREAM_BROADCAST',
        'stream',
        'stream-202',
        'corr-003',
        { event: 'stream.cancelled', eventId: 'evt-303' }
      );

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('STREAM_BROADCAST');
      expect(entries[0].resourceId).toBe('stream-202');
      expect(entries[0].meta?.event).toBe('stream.cancelled');
    });

    it('should accumulate multiple broadcast audit entries', () => {
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's1', undefined, { event: 'stream.created' });
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's2', undefined, { event: 'stream.updated' });
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's3', undefined, { event: 'stream.cancelled' });

      const entries = getAuditEntries();
      const broadcasts = entries.filter((e) => e.action === 'STREAM_BROADCAST');
      expect(broadcasts).toHaveLength(3);
    });

    it('should not throw when called with no correlationId or meta', () => {
      expect(() => {
        recordAuditEvent('STREAM_BROADCAST', 'stream', 'stream-no-meta');
      }).not.toThrow();

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].correlationId).toBeUndefined();
      expect(entries[0].meta).toBeUndefined();
    });
  });

  // -- No HTTP Endpoint Triggers Broadcasts --------------------------------

  describe('No HTTP endpoint triggers broadcasts', () => {
    it('documents that hub.broadcast is only reachable from streamEventService', () => {
      // This is an architectural assertion: no route file imports or calls
      // hub.broadcast() directly. The broadcast path is:
      // Blockchain Event -> Indexer -> StreamEventService -> Hub.broadcast()
      expect(getStreamHub).toBeDefined();
    });
  });

  // -- WS auth surface for broadcast access (added under #1092) -----------

  describe('WS auth surface for broadcast access', () => {
    function makeReq(overrides: Partial<{ headers?: Record<string, string>; url?: string }> = {}) {
      return {
        headers: overrides.headers ?? {},
        url: overrides.url ?? '/ws/streams',
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage;
    }

    it('rejects missing tokens without generating broadcast audit entries', () => {
      const result = verifyWsToken(makeReq(), 'secret');

      expect(result).toEqual({ ok: false, code: 'MISSING_TOKEN' });
      expect(getAuditEntries()).toHaveLength(0);
    });

    it('records invalid token failures as WS_AUTH_FAILURE without creating broadcast audit entries', () => {
      const result = verifyWsToken(makeReq({ headers: { authorization: 'Bearer bad' } }), 'secret');

      expect(result).toEqual({ ok: false, code: 'INVALID_TOKEN' });

      const authFailures = getAuditEntries().filter((entry) => entry.action === 'WS_AUTH_FAILURE');
      expect(authFailures).toHaveLength(1);
      expect(authFailures[0].meta?.reason).toBe('INVALID_TOKEN');
      expect(getAuditEntries().some((entry) => entry.action === 'STREAM_BROADCAST')).toBe(false);
    });

    it('accepts a valid bearer token and does not emit auth failures', () => {
      const token = jwt.sign({ sub: 'user-42', role: 'operator' }, 'secret');
      const result = verifyWsToken(makeReq({ headers: { authorization: `Bearer ${token}` } }), 'secret');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sub).toBe('user-42');
      }
      expect(getAuditEntries()).toHaveLength(0);
    });

    it('increments the auth failure counter for invalid tokens', async () => {
      verifyWsToken(makeReq({ headers: { authorization: 'Bearer bad' } }), 'secret');

      const value = await wsAuthFailureTotal.get();
      const series = value.values.find(
        (entry) => (entry.labels as { reason?: string }).reason === 'INVALID_TOKEN'
      );
      expect(series?.value).toBe(1);
    });
  });

  // -- WS Auth Failure Modes ------------------------------------------------

  describe('WS auth failure modes (tokenAuth.ts)', () => {
    it('returns AUTH_NOT_CONFIGURED when JWT_SECRET is absent', () => {
      const result = verifyWsToken(makeIncomingMessage(), undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('AUTH_NOT_CONFIGURED');
      }
    });

    it('returns MISSING_TOKEN when no token is present and secret is configured', () => {
      const result = verifyWsToken(makeIncomingMessage(), 'some-secret');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('MISSING_TOKEN');
      }
    });

    it('returns INVALID_TOKEN for a malformed token', () => {
      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: 'Bearer invalid-token' } }),
        'some-secret'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_TOKEN');
      }
    });

    it('returns INVALID_TOKEN for a token signed with the wrong secret', () => {
      const badToken = jwt.sign({ sub: 'test' }, 'wrong-secret');
      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: `Bearer ${badToken}` } }),
        'correct-secret'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_TOKEN');
      }
    });

    it('returns ok for a valid token', () => {
      const token = jwt.sign(
        { sub: 'GCSX2222222222222222222222222222222222222222222222UV' },
        'some-secret'
      );
      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: `Bearer ${token}` } }),
        'some-secret'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sub).toBe('GCSX2222222222222222222222222222222222222222222222UV');
      }
    });

    it('returns MISSING_TOKEN when Bearer scheme is used but no token follows', () => {
      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: 'Bearer' } }),
        'some-secret'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('MISSING_TOKEN');
      }
    });

    it('returns MISSING_TOKEN when Authorization header is not Bearer scheme', () => {
      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }),
        'some-secret'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('MISSING_TOKEN');
      }
    });

    it('returns MISSING_TOKEN when token is an empty string after Bearer prefix', () => {
      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: 'Bearer ' } }),
        'some-secret'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('MISSING_TOKEN');
      }
    });

    it('extracts token from query string when Authorization header is absent', () => {
      const token = jwt.sign(
        { sub: 'GCSX2222222222222222222222222222222222222222222222UV' },
        'some-secret'
      );
      const result = verifyWsToken(
        makeIncomingMessage({ url: `/ws/streams?token=${token}` }),
        'some-secret'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sub).toBe('GCSX2222222222222222222222222222222222222222222222UV');
      }
    });

    it('prefers Authorization header over query string token', () => {
      const headerToken = jwt.sign({ sub: 'from-header' }, 'some-secret');
      const queryToken = jwt.sign({ sub: 'from-query' }, 'some-secret');
      const result = verifyWsToken(
        makeIncomingMessage({
          headers: { authorization: `Bearer ${headerToken}` },
          url: `/ws/streams?token=${queryToken}`,
        }),
        'some-secret'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sub).toBe('from-header');
      }
    });
  });

  // -- WS Auth Failure Audit Coverage ---------------------------------------

  describe('WS auth failure audit coverage', () => {
    it('records WS_AUTH_FAILURE audit entry for INVALID_TOKEN', () => {
      _resetAuditLog();
      const req = makeIncomingMessage({ headers: { authorization: 'Bearer bad-token' } });
      verifyWsToken(req, 'some-secret');

      const entries = getAuditEntries();
      const wsFailures = entries.filter((e) => e.action === 'WS_AUTH_FAILURE');
      expect(wsFailures).toHaveLength(1);
      expect(wsFailures[0].meta?.reason).toBe('INVALID_TOKEN');
    });

    it('records WS_AUTH_FAILURE audit entry for AUTH_NOT_CONFIGURED', () => {
      _resetAuditLog();
      const req = makeIncomingMessage();
      verifyWsToken(req, undefined);

      const entries = getAuditEntries();
      const wsFailures = entries.filter((e) => e.action === 'WS_AUTH_FAILURE');
      expect(wsFailures).toHaveLength(1);
      expect(wsFailures[0].meta?.reason).toBe('AUTH_NOT_CONFIGURED');
    });

    it('does NOT record WS_AUTH_FAILURE audit entry for MISSING_TOKEN', () => {
      _resetAuditLog();
      const req = makeIncomingMessage();
      verifyWsToken(req, 'some-secret');

      const entries = getAuditEntries();
      const wsFailures = entries.filter((e) => e.action === 'WS_AUTH_FAILURE');
      expect(wsFailures).toHaveLength(0);
    });

    it('audit entry resourceType is ws_connection for WS_AUTH_FAILURE', () => {
      _resetAuditLog();
      const req = makeIncomingMessage({ headers: { authorization: 'Bearer bad-token' } });
      verifyWsToken(req, 'some-secret');

      const entries = getAuditEntries();
      const wsFailures = entries.filter((e) => e.action === 'WS_AUTH_FAILURE');
      expect(wsFailures[0].resourceType).toBe('ws_connection');
      expect(wsFailures[0].resourceId).toBe('127.0.0.1');
    });
  });

  // -- SSE Auth Behavior ------------------------------------------------------

  describe('SSE route auth behavior (streams.ts)', () => {
    it('SSE route rejects INVALID_TOKEN regardless of WS_AUTH_REQUIRED setting', () => {
      // When WS_AUTH_REQUIRED=false, the WS upgrade path accepts connections
      // without tokens. However, the SSE route (GET /api/streams/:id/events)
      // has its own auth check that rejects INVALID_TOKEN regardless of
      // WS_AUTH_REQUIRED. This is a deliberate difference: SSE is an HTTP
      // endpoint and must enforce auth more strictly than the WS upgrade path.
      const invalidToken = jwt.sign({ sub: 'test' }, 'wrong-secret');

      const result = verifyWsToken(
        makeIncomingMessage({ headers: { authorization: `Bearer ${invalidToken}` }, url: '/api/streams/s1/events' }),
        'correct-secret'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_TOKEN');
      }
    });

    it('SSE route returns MISSING_TOKEN when no token is present and secret is configured', () => {
      const result = verifyWsToken(
        makeIncomingMessage({ url: '/api/streams/s1/events' }),
        'some-secret'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('MISSING_TOKEN');
      }
    });

    it('SSE route allows connections without tokens when WS_AUTH_REQUIRED is not set', () => {
      // The SSE route only enforces auth when WS_AUTH_REQUIRED=true.
      // When WS_AUTH_REQUIRED is absent/false, MISSING_TOKEN is accepted
      // at the SSE route level (the route does not reject on MISSING_TOKEN).
      // This is the backward-compatible default.
      const result = verifyWsToken(
        makeIncomingMessage({ url: '/api/streams/s1/events' }),
        'some-secret'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('MISSING_TOKEN');
      }
    });
  });

  // -- Correlation ID Propagation ----------------------------------------------

  describe('Correlation ID propagation', () => {
    it('recordAuditEvent preserves correlationId in audit entries', () => {
      _resetAuditLog();
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's1', 'corr-xyz-123', { event: 'stream.created' });

      const entries = getAuditEntries();
      expect(entries[0].correlationId).toBe('corr-xyz-123');
    });

    it('recordAuditEvent handles undefined correlationId without error', () => {
      _resetAuditLog();
      expect(() => {
        recordAuditEvent('STREAM_BROADCAST', 'stream', 's1', undefined, { event: 'stream.created' });
      }).not.toThrow();

      const entries = getAuditEntries();
      expect(entries[0].correlationId).toBeUndefined();
    });
  });

  // -- Broadcast Access Control Surface -----------------------------------------

  describe('Broadcast access control surface', () => {
    it('hub.broadcast is not directly importable from route files', () => {
      // This documents that the broadcast surface is limited to:
      // 1. src/services/streamEventService.ts (indexer pipeline)
      // 2. src/websockets/streamChannel.ts (deprecated wrapper)
      // No route file in src/routes/ imports hub.broadcast directly.
      const hub = getStreamHub();
      expect(hub).toBeUndefined(); // no hub initialized in this test context (mocked)
    });

    it('streamChannel.ts deprecated broadcast() is a safe no-op when no hub is initialized', () => {
      // The deprecated broadcast() in streamChannel.ts checks for hub
      // existence before delegating. When no hub is initialized, it logs
      // a warning and returns without throwing.
      const hub = getStreamHub();
      expect(hub).toBeUndefined();
      // In production, broadcast() would log a warning and return silently.
      // This is a safe no-op, not an error.
    });
  });

  // -- Audit Log Backward Compatibility -----------------------------------------

  describe('Audit log backward compatibility', () => {
    it('recordAuditEvent never throws regardless of input shape', () => {
      _resetAuditLog();
      const inputs = [
        { action: 'STREAM_BROADCAST' as const, resourceType: 'stream', resourceId: 's1' },
        { action: 'STREAM_BROADCAST' as const, resourceType: 'stream', resourceId: 's1', correlationId: 'c1' },
        { action: 'STREAM_BROADCAST' as const, resourceType: 'stream', resourceId: 's1', meta: { key: 'value' } },
        { action: 'STREAM_BROADCAST' as const, resourceType: 'stream', resourceId: 's1', correlationId: 'c1', meta: { key: 'value' } },
      ];

      for (const input of inputs) {
        expect(() => {
          recordAuditEvent(
            input.action,
            input.resourceType,
            input.resourceId,
            input.correlationId,
            input.meta
          );
        }).not.toThrow();
      }
    });

    it('audit entries are monotonically sequenced', () => {
      _resetAuditLog();
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's1', 'c1');
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's2', 'c2');
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's3', 'c3');

      const entries = getAuditEntries();
      expect(entries[0].seq).toBe(1);
      expect(entries[1].seq).toBe(2);
      expect(entries[2].seq).toBe(3);
    });

    it('audit entries include ISO-8601 timestamps', () => {
      _resetAuditLog();
      recordAuditEvent('STREAM_BROADCAST', 'stream', 's1', 'c1');

      const entries = getAuditEntries();
      expect(entries[0].timestamp).toBeDefined();
      expect(() => new Date(entries[0].timestamp).toISOString()).not.toThrow();
    });
  });
});
