/**
 * Fluxora Backend — k6 Load Testing Harness
 * ===========================================
 * 
 * Entrypoint that composes all endpoint scenarios into a single test run.
 *
 * Usage:
 *   # Smoke test (default)
 *   k6 run k6/main.js
 *
 *   # Pick a profile
 *   k6 run -e PROFILE=load   k6/main.js
 *   k6 run -e PROFILE=stress k6/main.js
 *   k6 run -e PROFILE=soak   k6/main.js
 *
 *   # Override target URL
 *   k6 run -e K6_BASE_URL=https://staging.fluxora.io k6/main.js
 *
 * Profiles:
 *   smoke   — 5 VUs for 1 min   (CI gate)
 *   load    — 50 VUs for 5 min  (pre-release)
 *   stress  — ramp to 200 VUs   (capacity planning)
 *   soak    — 30 VUs for 24 min (memory leak / drift detection)
 *
 * Thresholds (SLOs):
 *   p(95) response time < 500 ms
 *   p(99) response time < 1 000 ms
 *   Error rate          < 1 %
 *   Health endpoint     < 200 ms p(99)
 *
 * Trust boundaries modelled:
 *   Public internet  → GET /health, GET /api/streams, GET /api/streams/:id
 *   Partner (future) → POST /api/streams (auth not yet enforced)
 *
 * Failure modes covered:
 *   - 404 for missing stream IDs
 *   - Empty/minimal POST bodies (current defaults vs. future validation)
 *   - Latency degradation under concurrency
 *
 * Intentional non-goals / follow-up:
 *   - Auth header injection (no JWT layer yet)
 *   - Database failure injection (in-memory store only)
 *   - Stellar RPC dependency simulation
 */

import { THRESHOLDS, PROFILES, PERFORMANCE_BUDGET } from './config.js';
import healthScenario from './scenarios/health.js';
import streamsListScenario from './scenarios/streams-list.js';
import streamsGetScenario from './scenarios/streams-get.js';
import streamsCreateScenario from './scenarios/streams-create.js';

// ---------------------------------------------------------------------------
// Profile selection
// ---------------------------------------------------------------------------
const profileName = (__ENV.PROFILE || 'smoke').toLowerCase();
const profile = PROFILES[profileName];
if (!profile) {
  throw new Error(
    `Unknown PROFILE "${profileName}". Choose: smoke, load, stress, soak.`,
  );
}

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    health: {
      executor: 'ramping-vus',
      exec: 'health',
      ...profile,
      tags: { scenario: 'health' },
    },
    streams_list: {
      executor: 'ramping-vus',
      exec: 'streams_list',
      ...profile,
      tags: { scenario: 'streams_list' },
    },
    streams_get: {
      executor: 'ramping-vus',
      exec: 'streams_get',
      ...profile,
      tags: { scenario: 'streams_get' },
    },
    streams_create: {
      executor: 'ramping-vus',
      exec: 'streams_create',
      ...profile,
      tags: { scenario: 'streams_create' },
    },
  },
  thresholds: THRESHOLDS,
};

// ---------------------------------------------------------------------------
// Exported scenario functions (referenced by exec in options.scenarios)
// ---------------------------------------------------------------------------
export function health() {
  healthScenario();
}

export function streams_list() {
  streamsListScenario();
}

export function streams_get() {
  streamsGetScenario();
}

export function streams_create() {
  streamsCreateScenario();
}

// ---------------------------------------------------------------------------
// Comparable cross-release summary (performance budget gate)
// ---------------------------------------------------------------------------
function metricPercents(data, name) {
  const m = data.metrics[name];
  if (!m || !m.values) return { p95: null, p99: null };
  return {
    p95: m.values['p(95)'] ?? null,
    p99: m.values['p(99)'] ?? null,
  };
}

/**
 * Emit a stable JSON summary so release-to-release latency can be compared
 * by endpoint id. Also used by scripts/check-performance-budget.mjs.
 */
export function handleSummary(data) {
  const rows = PERFORMANCE_BUDGET.endpoints.map((endpoint) => {
    const tagged = metricPercents(
      data,
      `http_req_duration{endpoint:${endpoint.id}}`,
    );
    const trend = metricPercents(data, endpoint.trendMetric);
    const p95 = tagged.p95 ?? trend.p95;
    const p99 = tagged.p99 ?? trend.p99;
    const budgetP95 = endpoint.budgets.p95 ?? null;
    const budgetP99 = endpoint.budgets.p99 ?? null;
    const p95Ok = budgetP95 == null || p95 == null || p95 <= budgetP95;
    const p99Ok = budgetP99 == null || p99 == null || p99 <= budgetP99;
    return {
      endpoint: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      p95_ms: p95,
      p99_ms: p99,
      budget_p95_ms: budgetP95,
      budget_p99_ms: budgetP99,
      passed: p95Ok && p99Ok,
    };
  });

  const summary = {
    version: PERFORMANCE_BUDGET.version,
    unit: PERFORMANCE_BUDGET.unit,
    profile: (__ENV.PROFILE || 'smoke').toLowerCase(),
    generatedAt: new Date().toISOString(),
    endpoints: rows,
  };

  const lines = rows
    .map(
      (r) =>
        `${r.endpoint}: p95=${r.p95_ms ?? 'n/a'} (budget ${r.budget_p95_ms ?? '-'}) ` +
        `p99=${r.p99_ms ?? 'n/a'} (budget ${r.budget_p99_ms ?? '-'}) ` +
        `${r.passed ? 'PASS' : 'FAIL'}`,
    )
    .join('\n');

  return {
    'k6/results/performance-budget-summary.json': JSON.stringify(summary, null, 2) + '\n',
    stdout: `\n=== Performance budget summary ===\n${lines}\n`,
  };
}
