/**
 * Cardinality policy unit tests.
 *
 * Acceptance (issue #1431):
 * - Policy states which values may / may not be used as labels.
 * - High-cardinality values are excluded or bucketed.
 * - Series count stays bounded under varied path-parameter input.
 * - New collectors are checked against the policy via assertCollectorLabels.
 */

import { describe, it, expect } from 'vitest';
import { Counter, Registry } from 'prom-client';
import type { Request } from 'express';
import {
  normalizeRouteLabel,
  isHighCardinalitySegment,
  assertCollectorLabels,
  countMetricSeries,
  FORBIDDEN_LABEL_NAMES,
  ALLOWED_LABEL_NAMES,
  HIGH_CARDINALITY_BUCKET,
  ADDRESS_BUCKET,
} from '../../src/metrics/cardinality.js';
import { resolveRoute } from '../../src/middleware/httpMetrics.js';

describe('metric cardinality policy', () => {
  it('documents forbidden vs allowed label names', () => {
    expect(FORBIDDEN_LABEL_NAMES.has('stream_id')).toBe(true);
    expect(FORBIDDEN_LABEL_NAMES.has('tenant')).toBe(true);
    expect(FORBIDDEN_LABEL_NAMES.has('address')).toBe(true);
    expect(FORBIDDEN_LABEL_NAMES.has('originalUrl')).toBe(true);

    expect(ALLOWED_LABEL_NAMES.has('route')).toBe(true);
    expect(ALLOWED_LABEL_NAMES.has('method')).toBe(true);
    expect(ALLOWED_LABEL_NAMES.has('outcome')).toBe(true);
    expect(ALLOWED_LABEL_NAMES.has('status_code')).toBe(true);
  });

  it('detects high-cardinality path segments', () => {
    expect(isHighCardinalitySegment('550e8400-e29b-41d4-a716-446655440000')).toBe(
      true,
    );
    expect(isHighCardinalitySegment('12345')).toBe(true);
    expect(
      isHighCardinalitySegment(
        'GCSX22222222222222222222222222222222222222222222222222UV',
      ),
    ).toBe(true);
    expect(isHighCardinalitySegment('streams')).toBe(false);
    expect(isHighCardinalitySegment('health')).toBe(false);
    expect(isHighCardinalitySegment(':id')).toBe(false);
  });

  it('buckets UUIDs, numeric ids, and Stellar addresses in routes', () => {
    expect(
      normalizeRouteLabel(
        '/api/streams/550e8400-e29b-41d4-a716-446655440000',
      ),
    ).toBe(`/api/streams/${HIGH_CARDINALITY_BUCKET}`);

    expect(normalizeRouteLabel('/api/streams/99999/events/42')).toBe(
      `/api/streams/${HIGH_CARDINALITY_BUCKET}/events/${HIGH_CARDINALITY_BUCKET}`,
    );

    expect(
      normalizeRouteLabel(
        '/api/accounts/GCSX22222222222222222222222222222222222222222222222222UV',
      ),
    ).toBe(`/api/accounts/${ADDRESS_BUCKET}`);

    expect(normalizeRouteLabel('/health')).toBe('/health');
    expect(normalizeRouteLabel('/')).toBe('/');
  });

  it('strips query strings before bucketing', () => {
    expect(
      normalizeRouteLabel(
        '/api/streams/550e8400-e29b-41d4-a716-446655440000?foo=1',
      ),
    ).toBe(`/api/streams/${HIGH_CARDINALITY_BUCKET}`);
  });

  it('assertCollectorLabels rejects forbidden names', () => {
    expect(() => assertCollectorLabels(['method', 'route'])).not.toThrow();
    expect(() => assertCollectorLabels(['stream_id'])).toThrow(/forbidden/i);
    expect(() => assertCollectorLabels(['outcome', 'tenant_id'])).toThrow(
      /tenant_id/,
    );
  });

  it('keeps series count bounded under many distinct path parameters', async () => {
    const registry = new Registry();
    assertCollectorLabels(['method', 'route', 'status_code']);

    const counter = new Counter({
      name: 'http_requests_total_cardinality_probe',
      help: 'Probe counter for cardinality bound test',
      labelNames: ['method', 'route', 'status_code'] as const,
      registers: [registry],
    });

    const distinctIds = 200;
    for (let i = 0; i < distinctIds; i++) {
      const uuid = `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`;
      const req = {
        baseUrl: '',
        route: undefined,
        method: 'GET',
        originalUrl: `/api/streams/${uuid}`,
      } as unknown as Request;

      const route = resolveRoute(req);
      counter.inc({ method: 'GET', route, status_code: '404' });
    }

    // Also vary numeric and address-shaped segments.
    for (let i = 0; i < 50; i++) {
      const req = {
        baseUrl: '',
        route: undefined,
        originalUrl: `/api/streams/${10000 + i}`,
      } as unknown as Request;
      counter.inc({
        method: 'GET',
        route: resolveRoute(req),
        status_code: '404',
      });
    }

    const text = await registry.metrics();
    const series = countMetricSeries(text, 'http_requests_total_cardinality_probe');

    // All 250 distinct path params must collapse into a single route label
    // (plus at most method/status dimensions we kept fixed) → 1 series.
    expect(series).toBe(1);
    expect(series).toBeLessThanOrEqual(5);
    expect(text).toContain('route="/api/streams/:id"');
    expect(text).not.toMatch(/550e8400-e29b-41d4-a716-/);
  });
});

describe('resolveRoute cardinality integration', () => {
  it('does not emit unique series per unmatched path id', () => {
    const routes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      // UUID tenants + 3+ digit stream ids → both bucketed to :id
      const uuidReq = {
        baseUrl: '',
        route: undefined,
        originalUrl: `/api/tenants/550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}/streams/${1000 + i}`,
      } as unknown as Request;
      routes.add(resolveRoute(uuidReq));
    }
    expect(routes.size).toBe(1);
    expect([...routes][0]).toBe('/api/tenants/:id/streams/:id');
  });
});
