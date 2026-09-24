/**
 * Shared configuration for Fluxora k6 load tests.
 *
 * BASE_URL defaults to http://localhost:3000 and can be overridden via
 * the K6_BASE_URL environment variable:
 *   k6 run -e K6_BASE_URL=https://staging.fluxora.io k6/main.js
 *
 * Latency budgets are loaded from performance-budget.json (single source of
 * truth, reviewed against production observations). A run that exceeds any
 * budget fails via k6 thresholds.
 */

export const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';

const budget = JSON.parse(open('./performance-budget.json'));

function pctThresholds(budgets) {
  const parts = [];
  if (budgets.p95 != null) parts.push(`p(95)<${budgets.p95}`);
  if (budgets.p99 != null) parts.push(`p(99)<${budgets.p99}`);
  return parts;
}

/**
 * Baseline SLOs — derived from k6/performance-budget.json so regressions are
 * pinpointed and comparable across releases.
 *
 * Global
 *   p(95) < 500 ms, p(99) < 1 000 ms, error rate < 1 %
 *
 * Per-endpoint (tagged via { endpoint: '<name>' } on each request):
 *   health / streams_list / streams_get / streams_create — see budget file
 *
 * Custom trend metrics (from helpers.js) mirror the tagged thresholds and
 * appear in the k6 summary as human-readable named series.
 */
export const PERFORMANCE_BUDGET = budget;

export const THRESHOLDS = {
  // Global baseline
  http_req_duration: pctThresholds(budget.global.http_req_duration),
  http_req_failed: [`rate<${budget.global.http_req_failed_rate}`],
};

for (const endpoint of budget.endpoints) {
  const limits = pctThresholds(endpoint.budgets);
  THRESHOLDS[`http_req_duration{endpoint:${endpoint.id}}`] = limits;
  THRESHOLDS[endpoint.trendMetric] = limits;
}

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
