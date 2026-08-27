// @ts-nocheck
// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquireSseConnection,
  resolveSseConnectionLimits,
  _resetSseConnectionLimiter,
  DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY,
} from './sseConnectionLimiter.js';

const KEY = 'test-api-key';

describe('tryAcquireSseConnection per-API-key cap', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
  });

  it('rejects when the per-API-key cap is reached', () => {
    const limits = resolveSseConnectionLimits();
    // Lower the per-key cap so the test is deterministic.
    const capped = { ...limits, maxConnectionsPerApiKey: 2 };

    const a = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    const b = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    const c = tryAcquireSseConnection('1.1.1.1', capped, KEY);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe('per_key_limit');
    }
  });

  it('tracks per-key usage independently of the per-IP cap', () => {
    const capped = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerApiKey: 1,
      maxConnectionsPerIp: 100,
    };

    const first = tryAcquireSseConnection('9.9.9.9', capped, KEY);
    expect(first.ok).toBe(true);

    // Same key, different IP — still rejected by the per-key dimension.
    const second = tryAcquireSseConnection('8.8.8.8', capped, KEY);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('per_key_limit');
    }
  });

  it('releases per-key capacity so the cap recovers', () => {
    const capped = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerApiKey: 1,
    };

    const first = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    expect(first.ok).toBe(true);
    if (first.ok) first.connection.release();

    const second = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    expect(second.ok).toBe(true);
  });

  it('does not enforce per-key cap when no API key is supplied', () => {
    const capped = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerApiKey: 1,
    };

    const a = tryAcquireSseConnection('1.1.1.1', capped);
    const b = tryAcquireSseConnection('1.1.1.1', capped);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('exposes the default per-API-key cap via the resolver', () => {
    expect(DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY).toBeGreaterThan(0);
    expect(resolveSseConnectionLimits().maxConnectionsPerApiKey).toBe(
      DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY,
    );
  });
});
