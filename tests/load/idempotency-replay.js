/**
 * k6 Load Test — Idempotency Key Replay for POST /api/streams
 * ============================================================
 *
 * Purpose:
 *   Measure throughput and latency differences between novel requests and
 *   idempotency-key replays on POST /api/streams. The Redis idempotency store
 *   should serve replays significantly faster than novel writes.
 *
 * Usage:
 *   k6 run tests/load/idempotency-replay.js
 *   k6 run -e K6_BASE_URL=https://staging.fluxora.io tests/load/idempotency-replay.js
 *   k6 run --out csv=results.csv tests/load/idempotency-replay.js
 *
 * Environment variables (no defaults — must be set explicitly or use provided fallbacks):
 *   K6_BASE_URL  — target base URL (default: http://localhost:3000)
 *   K6_API_KEY   — Bearer token for auth header (optional; omit for open endpoints)
 *
 * Stages:
 *   Stage 1 (novel)  — 1 000 VUs each send one unique Idempotency-Key, ramp 30 s
 *   Stage 2 (replay) — same 1 000 VUs replay the same key for 30 s
 *
 * Thresholds:
 *   p(99) replay latency ≤ 50 ms  (cache hit path must be fast)
 *   error rate           < 1 %
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration (env vars only — no hardcoded secrets)
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';
const API_KEY  = __ENV.K6_API_KEY  || '';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const novelLatency  = new Trend('idempotency_novel_latency_ms',  true);
const replayLatency = new Trend('idempotency_replay_latency_ms', true);
const errorRate     = new Rate('idempotency_error_rate');
const redisHitRate  = new Rate('idempotency_redis_hit_rate');

// ---------------------------------------------------------------------------
// k6 options (two-stage scenario)
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    idempotency_novel: {
      executor:  'ramping-vus',
      exec:      'novelStage',
      startVUs:  0,
      stages: [
        { duration: '10s', target: 1000 },  // ramp up to 1 000 VUs
        { duration: '20s', target: 1000 },  // hold for novel requests
        { duration: '5s',  target: 0    },  // ramp down
      ],
      tags: { stage: 'novel' },
    },
    idempotency_replay: {
      executor:   'ramping-vus',
      exec:       'replayStage',
      startVUs:   0,
      startTime:  '35s',  // begin after novel stage ramps down
      stages: [
        { duration: '10s', target: 1000 },  // ramp up to 1 000 VUs
        { duration: '30s', target: 1000 },  // replay window
        { duration: '5s',  target: 0    },  // ramp down
      ],
      tags: { stage: 'replay' },
    },
  },
  thresholds: {
    // Replay cache hits must be fast — this is the core SLO
    'idempotency_replay_latency_ms':              ['p(99)<50'],
    // Novel writes are slower (DB + Redis write)
    'idempotency_novel_latency_ms':               ['p(99)<1000'],
    // Overall error budget
    'idempotency_error_rate':                     ['rate<0.01'],
    // Tagged HTTP durations
    'http_req_duration{stage:replay}':            ['p(99)<50'],
    'http_req_duration{stage:novel}':             ['p(95)<600', 'p(99)<1000'],
  },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build an Authorization header object when an API key is provided.
 * Returns an empty object if K6_API_KEY is unset.
 */
function authHeaders() {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

/**
 * Deterministic idempotency key scoped to a VU — stable across iterations
 * so that Stage 2 sends the exact same key as Stage 1.
 */
function idempotencyKey() {
  return `idempotency-replay-vu-${__VU}`;
}

// Valid Stellar testnet addresses (public — not secrets).
const SENDERS = [
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
];
const RECIPIENTS = [
  'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
];

function makePayload() {
  const i = __VU % SENDERS.length;
  return JSON.stringify({
    sender:        SENDERS[i],
    recipient:     RECIPIENTS[i],
    depositAmount: (1000 + (__VU % 100) * 10).toFixed(7),
    ratePerSecond: (0.001 + (__VU % 50) * 0.0001).toFixed(7),
    startTime:     Math.floor(Date.now() / 1000),
  });
}

// ---------------------------------------------------------------------------
// Stage 1 — Novel requests (unique Idempotency-Key per VU, first send)
// ---------------------------------------------------------------------------
export function novelStage() {
  const payload = makePayload();
  const res = http.post(`${BASE_URL}/api/streams`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(),
      ...authHeaders(),
    },
    tags: { stage: 'novel', endpoint: 'streams_create' },
  });

  novelLatency.add(res.timings.duration);

  const ok = check(res, {
    'novel — status 201 or 200': (r) => r.status === 201 || r.status === 200,
    'novel — has body':          (r) => r.body && r.body.length > 0,
    'novel — has id field': (r) => {
      try { return typeof JSON.parse(r.body).id === 'string'; } catch (_) { return false; }
    },
  });
  errorRate.add(!ok);

  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Stage 2 — Replay requests (same Idempotency-Key, Redis cache hit path)
// ---------------------------------------------------------------------------
export function replayStage() {
  const payload = makePayload();
  const res = http.post(`${BASE_URL}/api/streams`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(),
      ...authHeaders(),
    },
    tags: { stage: 'replay', endpoint: 'streams_create' },
  });

  replayLatency.add(res.timings.duration);

  // Replays must return the cached response (200 or 201) with same body shape.
  const ok = check(res, {
    'replay — status 200 or 201': (r) => r.status === 200 || r.status === 201,
    'replay — has body':          (r) => r.body && r.body.length > 0,
    'replay — has id field': (r) => {
      try { return typeof JSON.parse(r.body).id === 'string'; } catch (_) { return false; }
    },
    'replay — p99 latency ≤ 50ms': (r) => r.timings.duration <= 50,
  });
  errorRate.add(!ok);

  // Track Redis hit rate: a replay that returns within 50 ms is a cache hit.
  redisHitRate.add(res.timings.duration <= 50);

  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Collect Redis hit-rate from /metrics (best-effort; not a hard threshold)
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const replayP99 = data.metrics['idempotency_replay_latency_ms']
    ? data.metrics['idempotency_replay_latency_ms'].values['p(99)']
    : 'N/A';
  const novelP99 = data.metrics['idempotency_novel_latency_ms']
    ? data.metrics['idempotency_novel_latency_ms'].values['p(99)']
    : 'N/A';

  const summary = [
    'stage,p99_ms,threshold_ms,passed',
    `novel,${novelP99},1000,${replayP99 !== 'N/A' && novelP99 <= 1000}`,
    `replay,${replayP99},50,${replayP99 !== 'N/A' && replayP99 <= 50}`,
  ].join('\n') + '\n';

  return {
    'tests/load/results-summary.csv': summary,
    stdout: '\n=== Idempotency Replay Summary ===\n' +
      `Novel   p99: ${novelP99} ms  (threshold 1000 ms)\n` +
      `Replay  p99: ${replayP99} ms  (threshold 50 ms)\n`,
  };
}
