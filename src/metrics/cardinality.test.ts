import { describe, it, expect } from 'vitest';
import { Counter, Registry } from 'prom-client';
import {
  ADDRESS_BUCKET,
  CardinalityValidationError,
  HIGH_CARDINALITY_BUCKET,
  MAX_LABEL_NAME_LENGTH,
  MAX_METRIC_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_PROMETHEUS_TEXT_LENGTH,
  UNKNOWN_ROUTE_BUCKET,
  assertCollectorLabels,
  bucketPathSegment,
  countMetricSeries,
  isHighCardinalitySegment,
  normalizeRouteLabel,
} from './cardinality';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDRESS =
  'GCSX22222222222222222222222222222222222222222222222222UV';

function captureValidationError(
  fn: () => unknown,
): CardinalityValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CardinalityValidationError);
  return thrown as CardinalityValidationError;
}

describe('cardinality input validation', () => {
  describe('valid input is unaffected', () => {
    it('normalizes valid routes exactly as before', () => {
      expect(normalizeRouteLabel(`/api/streams/${UUID}`)).toBe(
        `/api/streams/${HIGH_CARDINALITY_BUCKET}`,
      );
      expect(normalizeRouteLabel(`/api/accounts/${ADDRESS}`)).toBe(
        `/api/accounts/${ADDRESS_BUCKET}`,
      );
      expect(normalizeRouteLabel('/api/streams/99999?expand=events')).toBe(
        `/api/streams/${HIGH_CARDINALITY_BUCKET}`,
      );
      expect(normalizeRouteLabel('/health/')).toBe('/health');
      expect(normalizeRouteLabel('/')).toBe('/');
    });

    it('validates and buckets path segments', () => {
      expect(isHighCardinalitySegment(UUID)).toBe(true);
      expect(isHighCardinalitySegment('12345')).toBe(true);
      expect(isHighCardinalitySegment('streams')).toBe(false);
      expect(isHighCardinalitySegment(':id')).toBe(false);

      expect(bucketPathSegment(ADDRESS)).toBe(ADDRESS_BUCKET);
      expect(bucketPathSegment(UUID)).toBe(HIGH_CARDINALITY_BUCKET);
      expect(bucketPathSegment('streams')).toBe('streams');
    });

    it('accepts allowed collector labels without mutating them', () => {
      const labels = Object.freeze(['method', 'route', 'status_code']);
      expect(() => assertCollectorLabels(labels)).not.toThrow();
      expect(labels).toEqual(['method', 'route', 'status_code']);
      expect(() => assertCollectorLabels([])).not.toThrow();
    });

    it('counts series for a valid scrape', () => {
      const text = [
        '# HELP http_requests_total Total requests',
        '# TYPE http_requests_total counter',
        'http_requests_total{method="GET",route="/health"} 2',
        'http_requests_total{method="POST",route="/health"} 1',
        'go_goroutines 3',
      ].join('\n');

      expect(countMetricSeries(text, 'http_requests_total')).toBe(2);
      expect(countMetricSeries(text, 'go_goroutines')).toBe(1);
    });
  });

  describe('rejections', () => {
    it('rejects empty input with a typed, explainable error', () => {
      const cases: Array<{
        fn: () => unknown;
        code: CardinalityValidationError['code'];
        field: string;
      }> = [
        {
          fn: () => normalizeRouteLabel(''),
          code: 'EMPTY_INPUT',
          field: 'rawPath',
        },
        {
          fn: () => normalizeRouteLabel('   '),
          code: 'EMPTY_INPUT',
          field: 'rawPath',
        },
        {
          fn: () => isHighCardinalitySegment(''),
          code: 'EMPTY_INPUT',
          field: 'segment',
        },
        {
          fn: () => bucketPathSegment(''),
          code: 'EMPTY_INPUT',
          field: 'segment',
        },
        {
          fn: () => assertCollectorLabels(['']),
          code: 'EMPTY_INPUT',
          field: 'labelNames[0]',
        },
        {
          fn: () => countMetricSeries('', 'http_requests_total'),
          code: 'EMPTY_INPUT',
          field: 'prometheusText',
        },
        {
          fn: () => countMetricSeries('# EOF', ''),
          code: 'EMPTY_INPUT',
          field: 'metricName',
        },
      ];

      for (const { fn, code, field } of cases) {
        const error = captureValidationError(fn);
        expect(error.code).toBe(code);
        expect(error.field).toBe(field);
        expect(error.reason).toBeTruthy();
      }
    });

    it('rejects malformed input with a typed error', () => {
      const nonString = captureValidationError(() =>
        normalizeRouteLabel(undefined as unknown as string),
      );
      expect(nonString.code).toBe('INVALID_TYPE');
      expect(nonString.field).toBe('rawPath');

      const controlChars = captureValidationError(() =>
        normalizeRouteLabel('/api/\u0000/streams'),
      );
      expect(controlChars.code).toBe('MALFORMED_INPUT');
      expect(controlChars.reason).toMatch(/control characters/);

      const badLabel = captureValidationError(() =>
        assertCollectorLabels(['route\n']),
      );
      expect(badLabel.code).toBe('MALFORMED_INPUT');
      expect(badLabel.field).toBe('labelNames[0]');

      const nonArray = captureValidationError(() =>
        assertCollectorLabels(null as unknown as string[]),
      );
      expect(nonArray.code).toBe('INVALID_TYPE');
      expect(nonArray.field).toBe('labelNames');

      const badMetricName = captureValidationError(() =>
        countMetricSeries('# EOF', 'not a metric'),
      );
      expect(badMetricName.code).toBe('MALFORMED_INPUT');
      expect(badMetricName.field).toBe('metricName');
    });

    it('rejects oversized input with a typed error', () => {
      const path = captureValidationError(() =>
        normalizeRouteLabel(`/${'a'.repeat(MAX_PATH_LENGTH)}`),
      );
      expect(path.code).toBe('OVERSIZED_INPUT');
      expect(path.field).toBe('rawPath');

      const segment = captureValidationError(() =>
        isHighCardinalitySegment('a'.repeat(MAX_PATH_LENGTH + 1)),
      );
      expect(segment.code).toBe('OVERSIZED_INPUT');
      expect(segment.field).toBe('segment');

      const label = captureValidationError(() =>
        assertCollectorLabels(['a'.repeat(MAX_LABEL_NAME_LENGTH + 1)]),
      );
      expect(label.code).toBe('OVERSIZED_INPUT');

      const metric = captureValidationError(() =>
        countMetricSeries(
          '# EOF',
          'a'.repeat(MAX_METRIC_NAME_LENGTH + 1),
        ),
      );
      expect(metric.code).toBe('OVERSIZED_INPUT');
      expect(metric.field).toBe('metricName');

      const scrape = captureValidationError(() =>
        countMetricSeries(
          'a'.repeat(MAX_PROMETHEUS_TEXT_LENGTH + 1),
          'http_requests_total',
        ),
      );
      expect(scrape.code).toBe('OVERSIZED_INPUT');
      expect(scrape.field).toBe('prometheusText');
    });

    it('rejects forbidden labels with a typed reason', () => {
      const error = captureValidationError(() =>
        assertCollectorLabels(['outcome', 'tenant_id']),
      );
      expect(error.code).toBe('FORBIDDEN_LABEL');
      expect(error.field).toBe('labelNames');
      expect(error.reason).toContain('tenant_id');
      expect(error.reason).toContain('forbidden');
    });
  });

  describe('rejection happens before any state write', () => {
    it('does not mutate metric registry state on rejected input', async () => {
      const registry = new Registry();
      const counter = new Counter({
        name: 'cardinality_validation_probe_total',
        help: 'Probe used to prove rejected inputs write no state',
        labelNames: ['route'] as const,
        registers: [registry],
      });
      counter.inc({ route: '/health' });

      const before = await registry.metrics();

      expect(() => normalizeRouteLabel('')).toThrow(
        CardinalityValidationError,
      );
      expect(() =>
        normalizeRouteLabel(`/${'a'.repeat(MAX_PATH_LENGTH)}`),
      ).toThrow(CardinalityValidationError);
      expect(() => assertCollectorLabels(['tenant_id'])).toThrow(
        CardinalityValidationError,
      );
      expect(() => countMetricSeries('', 'http_requests_total')).toThrow(
        CardinalityValidationError,
      );

      const after = await registry.metrics();
      expect(after).toBe(before);
    });

    it('does not mutate the caller label array on rejection', () => {
      const labels = Object.freeze(['outcome', 'tenant_id']);
      expect(() => assertCollectorLabels(labels)).toThrow(
        CardinalityValidationError,
      );
      expect(labels).toEqual(['outcome', 'tenant_id']);
    });
  });

  it('keeps the unknown-route sentinel for callers that need it', () => {
    expect(UNKNOWN_ROUTE_BUCKET).toBe('unmatched');
  });
});
