/**
 * Comprehensive edge-case tests for resolvePerRouteOverride() in src/tracing/sampling.ts
 *
 * `resolvePerRouteOverride` returns the matched override as `{ rate, key }`:
 * `rate` is the sample rate to apply and `key` is the override that matched,
 * which callers use to rewrite the recorded route attribute to a canonical,
 * non-identifying value. These expectations were stale after that signature
 * change landed and are updated here to assert the real contract (#1518).
 */

import { describe, it, expect } from 'vitest';
import { resolvePerRouteOverride } from './hooks.js';

describe('resolvePerRouteOverride()', () => {
  describe('Exact Match', () => {
    it('prefers an exact route override over prefix matches', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
        '/api/streams/live': 1.0,
      };

      expect(resolvePerRouteOverride('/api/streams', overrides)).toEqual({ rate: 0.5, key: '/api/streams' });
      expect(resolvePerRouteOverride('/api', overrides)).toEqual({ rate: 0.2, key: '/api' });
      expect(resolvePerRouteOverride('/api/streams/live', overrides)).toEqual({ rate: 1.0, key: '/api/streams/live' });
    });

    it('returns exact match rate when rate is 0', () => {
      const overrides: Record<string, number> = {
        '/health': 0,
        '/api': 0.5,
      };

      expect(resolvePerRouteOverride('/health', overrides)).toEqual({ rate: 0, key: '/health' });
    });
  });

  describe('Longest Prefix Match', () => {
    it('selects the most specific (longest) prefix match', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
      };

      expect(resolvePerRouteOverride('/api/streams/abc', overrides)).toEqual({ rate: 0.5, key: '/api/streams' });
    });

    it('chooses the longest matching key across multiple nested prefixes', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
        '/api/streams/live': 1.0,
      };

      expect(resolvePerRouteOverride('/api/streams/live/abc', overrides)).toEqual({ rate: 1.0, key: '/api/streams/live' });
      expect(resolvePerRouteOverride('/api/streams/vod/123', overrides)).toEqual({ rate: 0.5, key: '/api/streams' });
      expect(resolvePerRouteOverride('/api/users/456', overrides)).toEqual({ rate: 0.2, key: '/api' });
    });

    it('handles shorter prefix when longer prefix does not match', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
      };

      expect(resolvePerRouteOverride('/api/webhooks', overrides)).toEqual({ rate: 0.2, key: '/api' });
    });
  });

  describe('Substring False-Positive Prevention', () => {
    it('does NOT match routes that share a character prefix but are not path-segment descendants', () => {
      const overrides: Record<string, number> = {
        '/api/str': 0.8,
      };

      expect(resolvePerRouteOverride('/api/stream-x', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/api/streamSomething', overrides)).toBeUndefined();
    });

    it('verifies regression coverage: matches valid path-segment descendants and exact matches', () => {
      const overrides: Record<string, number> = {
        '/api/str': 0.8,
      };

      expect(resolvePerRouteOverride('/api/str', overrides)).toEqual({ rate: 0.8, key: '/api/str' });
      expect(resolvePerRouteOverride('/api/str/foo', overrides)).toEqual({ rate: 0.8, key: '/api/str' });
      expect(resolvePerRouteOverride('/api/str/foo/bar', overrides)).toEqual({ rate: 0.8, key: '/api/str' });
      expect(resolvePerRouteOverride('/api/stream-x', overrides)).toBeUndefined();
    });

    it('prevents substring false-positive when target route has extra characters after prefix without slash', () => {
      const overrides: Record<string, number> = {
        '/api': 0.5,
      };

      expect(resolvePerRouteOverride('/apiv2', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/apiv2/users', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/api-v2', overrides)).toBeUndefined();
    });
  });

  describe('No Match', () => {
    it('returns undefined when no override matches', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/admin': 0.9,
      };

      expect(resolvePerRouteOverride('/metrics', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/health', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/', overrides)).toBeUndefined();
    });

    it('does not throw exceptions or return default sample rates for unknown routes', () => {
      const overrides: Record<string, number> = {
        '/api': 0.5,
      };

      expect(() => resolvePerRouteOverride('/unknown/route', overrides)).not.toThrow();
      expect(resolvePerRouteOverride('/unknown/route', overrides)).toBeUndefined();
    });
  });

  describe('Regression & Special Configurations', () => {
    it('returns undefined for an empty override map', () => {
      expect(resolvePerRouteOverride('/api/streams', {})).toBeUndefined();
    });

    it('handles single override configuration correctly', () => {
      const overrides: Record<string, number> = {
        '/api': 0.5,
      };

      expect(resolvePerRouteOverride('/api', overrides)).toEqual({ rate: 0.5, key: '/api' });
      expect(resolvePerRouteOverride('/api/users', overrides)).toEqual({ rate: 0.5, key: '/api' });
      expect(resolvePerRouteOverride('/apiv2', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/other', overrides)).toBeUndefined();
    });

    it('handles root path override ("/") correctly', () => {
      const overrides: Record<string, number> = {
        '/': 0.1,
      };

      expect(resolvePerRouteOverride('/', overrides)).toEqual({ rate: 0.1, key: '/' });
      expect(resolvePerRouteOverride('/api/streams', overrides)).toEqual({ rate: 0.1, key: '/' });
      expect(resolvePerRouteOverride('/health', overrides)).toEqual({ rate: 0.1, key: '/' });
    });

    it('handles override key with trailing slash correctly', () => {
      const overrides: Record<string, number> = {
        '/api/': 0.6,
      };

      expect(resolvePerRouteOverride('/api/streams', overrides)).toEqual({ rate: 0.6, key: '/api/' });
      expect(resolvePerRouteOverride('/api/', overrides)).toEqual({ rate: 0.6, key: '/api/' });
      expect(resolvePerRouteOverride('/api', overrides)).toBeUndefined();
    });
  });
});
