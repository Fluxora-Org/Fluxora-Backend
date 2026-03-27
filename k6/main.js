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

import { THRESHOLDS, PROFILES } from './config.js';
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
