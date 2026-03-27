/**
 * Shared configuration for Fluxora k6 load tests.
 *
 * BASE_URL defaults to http://localhost:3000 and can be overridden via
 * the K6_BASE_URL environment variable:
 *   k6 run -e K6_BASE_URL=https://staging.fluxora.io k6/main.js
 */

export const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';

/**
 * Service-level thresholds applied across all scenarios.
 * p(95) latency  < 500 ms
 * p(99) latency  < 1 000 ms
 * Error rate     < 1 %
 * Health checks  always < 200 ms p(99)
 */
export const THRESHOLDS = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
  'http_req_duration{endpoint:health}': ['p(99)<200'],
  'http_req_duration{endpoint:streams_list}': ['p(95)<500'],
  'http_req_duration{endpoint:streams_get}': ['p(95)<500'],
  'http_req_duration{endpoint:streams_create}': ['p(95)<500'],
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
