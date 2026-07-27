/**
 * Comprehensive edge-case tests for resolvePerRouteOverride() in src/tracing/hooks.ts
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

      expect(resolvePerRouteOverride('/api/streams', overrides)).toBe(0.5);
      expect(resolvePerRouteOverride('/api', overrides)).toBe(0.2);
      expect(resolvePerRouteOverride('/api/streams/live', overrides)).toBe(1.0);
    });

    it('returns exact match rate when rate is 0', () => {
      const overrides: Record<string, number> = {
        '/health': 0,
        '/api': 0.5,
      };

      expect(resolvePerRouteOverride('/health', overrides)).toBe(0);
    });
  });

  describe('Longest Prefix Match', () => {
    it('selects the most specific (longest) prefix match', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
      };

      expect(resolvePerRouteOverride('/api/streams/abc', overrides)).toBe(0.5);
    });

    it('chooses the longest matching key across multiple nested prefixes', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
        '/api/streams/live': 1.0,
      };

      expect(resolvePerRouteOverride('/api/streams/live/abc', overrides)).toBe(1.0);
      expect(resolvePerRouteOverride('/api/streams/vod/123', overrides)).toBe(0.5);
      expect(resolvePerRouteOverride('/api/users/456', overrides)).toBe(0.2);
    });

    it('handles shorter prefix when longer prefix does not match', () => {
      const overrides: Record<string, number> = {
        '/api': 0.2,
        '/api/streams': 0.5,
      };

      expect(resolvePerRouteOverride('/api/webhooks', overrides)).toBe(0.2);
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

      expect(resolvePerRouteOverride('/api/str', overrides)).toBe(0.8);
      expect(resolvePerRouteOverride('/api/str/foo', overrides)).toBe(0.8);
      expect(resolvePerRouteOverride('/api/str/foo/bar', overrides)).toBe(0.8);
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

      expect(resolvePerRouteOverride('/api', overrides)).toBe(0.5);
      expect(resolvePerRouteOverride('/api/users', overrides)).toBe(0.5);
      expect(resolvePerRouteOverride('/apiv2', overrides)).toBeUndefined();
      expect(resolvePerRouteOverride('/other', overrides)).toBeUndefined();
    });

    it('handles root path override ("/") correctly', () => {
      const overrides: Record<string, number> = {
        '/': 0.1,
      };

      expect(resolvePerRouteOverride('/', overrides)).toBe(0.1);
      expect(resolvePerRouteOverride('/api/streams', overrides)).toBe(0.1);
      expect(resolvePerRouteOverride('/health', overrides)).toBe(0.1);
    });

    it('handles override key with trailing slash correctly', () => {
      const overrides: Record<string, number> = {
        '/api/': 0.6,
      };

      expect(resolvePerRouteOverride('/api/streams', overrides)).toBe(0.6);
      expect(resolvePerRouteOverride('/api/', overrides)).toBe(0.6);
      expect(resolvePerRouteOverride('/api', overrides)).toBeUndefined();
    });
  });
});
