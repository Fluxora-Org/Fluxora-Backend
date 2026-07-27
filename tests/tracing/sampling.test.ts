/**
 * Trace Sampling Strategy Tests (#757)
 *
 * Covers:
 * - shouldSampleHead: determinism, boundaries, distribution
 * - shouldSampleTail: error span retention, normal sampling
 * - resolvePerRouteOverride: exact match, prefix match, no match
 * - getSamplingConfig: env var parsing for all strategies
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  samplingFnv1a32,
  shouldSampleHead,
  shouldSampleTail,
  resolvePerRouteOverride,
  type Span,
  type TailSamplingConfig,
} from '../../src/tracing/hooks.js';
import { getSamplingConfig } from '../../src/tracing/index.js';

describe('samplingFnv1a32', () => {
  it('is deterministic: same input → same hash', () => {
    expect(samplingFnv1a32('trace-abc-123')).toBe(samplingFnv1a32('trace-abc-123'));
  });

  it('produces different hashes for different inputs', () => {
    expect(samplingFnv1a32('aaaa')).not.toBe(samplingFnv1a32('bbbb'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = samplingFnv1a32('any-trace-id');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('shouldSampleHead', () => {
  it('always returns false for sampleRate=0', () => {
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleHead(`trace-${i}`, 0)).toBe(false);
    }
  });

  it('always returns true for sampleRate=1', () => {
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleHead(`trace-${i}`, 1)).toBe(true);
    }
  });

  it('is deterministic: same traceId always yields same decision', () => {
    for (let i = 0; i < 50; i++) {
      const id = `deterministic-trace-${i}`;
      const first = shouldSampleHead(id, 0.5);
      const second = shouldSampleHead(id, 0.5);
      expect(first).toBe(second);
    }
  });

  it('distributes approximately at the requested rate', () => {
    let kept = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (shouldSampleHead(`trace-id-${i}`, 0.5)) kept++;
    }
    const ratio = kept / total;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });
});

describe('shouldSampleTail', () => {
  function makeSpan(status: Span['status'], events: { name: string }[] = []): Span {
    return {
      context: { traceId: 'test', spanId: 'span1' },
      startTimeMs: Date.now(),
      status,
      events: events.map((e) => ({ ...e, timestamp: Date.now() })),
    };
  }

  it('keeps error spans when keepErrorSpans=true', () => {
    const span = makeSpan('error');
    expect(shouldSampleTail(span, { strategy: 'tail', sampleRate: 0, keepErrorSpans: true })).toBe(true);
  });

  it('keeps spans with an error event when keepErrorSpans=true', () => {
    const span = makeSpan('ok', [{ name: 'error' }]);
    expect(shouldSampleTail(span, { strategy: 'tail', sampleRate: 0, keepErrorSpans: true })).toBe(true);
  });

  it('drops error spans when keepErrorSpans=false', () => {
    const span = makeSpan('error');
    expect(shouldSampleTail(span, { strategy: 'tail', sampleRate: 0, keepErrorSpans: false })).toBe(false);
  });

  it('keeps all ok spans when sampleRate=1', () => {
    const span = makeSpan('ok');
    expect(shouldSampleTail(span, { strategy: 'tail', sampleRate: 1, keepErrorSpans: false })).toBe(true);
  });
});

describe('resolvePerRouteOverride', () => {
  const overrides: Record<string, number> = {
    '/health': 0,
    '/api': 0.5,
    '/api/streams': 1,
  };

  it('returns exact match', () => {
    expect(resolvePerRouteOverride('/health', overrides)).toBe(0);
    expect(resolvePerRouteOverride('/api/streams', overrides)).toBe(1);
  });

  it('returns longest prefix match when no exact match', () => {
    expect(resolvePerRouteOverride('/api/streams/abc', overrides)).toBe(1);
  });

  it('returns shorter prefix when longer does not match', () => {
    expect(resolvePerRouteOverride('/api/webhooks', overrides)).toBe(0.5);
  });

  it('returns undefined when no match at all', () => {
    expect(resolvePerRouteOverride('/internal/indexer', overrides)).toBeUndefined();
  });
});

describe('getSamplingConfig', () => {
  const ORIG = {
    TRACING_SAMPLING_STRATEGY: process.env.TRACING_SAMPLING_STRATEGY,
    TRACING_HEAD_SAMPLE_RATE: process.env.TRACING_HEAD_SAMPLE_RATE,
    TRACING_SAMPLE_RATE: process.env.TRACING_SAMPLE_RATE,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIG)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to head strategy', () => {
    delete process.env.TRACING_SAMPLING_STRATEGY;
    const cfg = getSamplingConfig();
    expect(cfg.strategy).toBe('head');
  });

  it('returns always strategy', () => {
    process.env.TRACING_SAMPLING_STRATEGY = 'always';
    const cfg = getSamplingConfig();
    expect(cfg.strategy).toBe('always');
  });

  it('parses head strategy with per-route overrides', () => {
    process.env.TRACING_SAMPLING_STRATEGY = 'head';
    process.env.TRACING_HEAD_SAMPLE_RATE = '0.3';
    process.env.TRACING_PER_ROUTE_OVERRIDES = JSON.stringify({ '/health': 0 });
    const cfg = getSamplingConfig();
    expect(cfg.strategy).toBe('head');
    if (cfg.strategy === 'head') {
      expect(cfg.sampleRate).toBe(0.3);
      expect(cfg.perRouteOverrides?.['/health']).toBe(0);
    }
  });
});
