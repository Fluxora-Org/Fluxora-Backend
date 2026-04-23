/**
 * Shared configuration for Fluxora k6 load tests.
 *
 * BASE_URL defaults to http://localhost:3000 and can be overridden via
 * the K6_BASE_URL environment variable:
 *   k6 run -e K6_BASE_URL=https://staging.fluxora.io k6/main.js
 */

export const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';

/**
 * Baseline SLOs — published per endpoint so regressions are pinpointed.
 *
 * Global
 *   p(95) < 500 ms, p(99) < 1 000 ms, error rate < 1 %
 *
 * Per-endpoint (tagged via { endpoint: '<name>' } on each request):
 *   health          p(99) < 200 ms  — used as readiness probe; must be fast
 *   streams_list    p(95) < 500 ms, p(99) < 800 ms
 *   streams_get     p(95) < 400 ms, p(99) < 700 ms
 *   streams_create  p(95) < 600 ms, p(99) < 1 000 ms  — write path is slower
 *
 * Custom trend metrics (from helpers.js) mirror the tagged thresholds and
 * appear in the k6 summary as human-readable named series.
 */
export const THRESHOLDS = {
  // Global baseline
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed:   ['rate<0.01'],

  // Per-endpoint SLOs (tagged requests)
  'http_req_duration{endpoint:health}':          ['p(99)<200'],
  'http_req_duration{endpoint:streams_list}':    ['p(95)<500', 'p(99)<800'],
  'http_req_duration{endpoint:streams_get}':     ['p(95)<400', 'p(99)<700'],
  'http_req_duration{endpoint:streams_create}':  ['p(95)<600', 'p(99)<1000'],

  // Named trend metrics (mirrors above; surfaced in k6 end-of-test summary)
  fluxora_health_latency:          ['p(99)<200'],
  fluxora_streams_list_latency:    ['p(95)<500', 'p(99)<800'],
  fluxora_streams_get_latency:     ['p(95)<400', 'p(99)<700'],
  fluxora_streams_create_latency:  ['p(95)<600', 'p(99)<1000'],
};

/**
 * Reusable stage profiles.
 */
export const PROFILES = {
  smoke: {
    stages: [
      { duration: '30s', target: 5 },
      { duration: '30s', target: 0 },
    ],
  },
  load: {
    stages: [
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0 },
    ],
  },
  stress: {
    stages: [
      { duration: '1m', target: 50 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 200 },
      { duration: '1m', target: 0 },
    ],
  },
  soak: {
    stages: [
      { duration: '2m', target: 30 },
      { duration: '20m', target: 30 },
      { duration: '2m', target: 0 },
    ],
  },
};
