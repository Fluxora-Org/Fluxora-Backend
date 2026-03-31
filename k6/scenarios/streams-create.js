import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../config.js';
import {
  checkResponse,
  errorRate,
  streamsCreateLatency,
  JSON_HEADERS,
  makeStreamPayload,
} from '../helpers.js';

let counter = 0;

/**
 * Exercises POST /api/streams.
 *
 * Trust boundary: authenticated partners (auth not yet enforced—recorded
 * as follow-up work).
 *
 * Expected behavior:
 *   - Valid payload  → 201 with the created stream (includes generated id).
 *   - Empty body     → the service currently defaults every field; load test
 *     confirms this doesn't crash but flags it as a gap for input validation.
 *
 * Failure modes tested:
 *   - Completely empty body (no JSON).
 *   - Missing required fields.
 */
export default function streamsCreateScenario() {
  counter++;

  // --- Happy path: well-formed payload ---
  const payload = makeStreamPayload(counter);
  const res = http.post(`${BASE_URL}/api/streams`, payload, {
    ...JSON_HEADERS,
    tags: { endpoint: 'streams_create' },
  });

  const passed = checkResponse(res, 201, 'POST /api/streams (valid)');
  if (passed) {
    check(res, {
      'POST /api/streams — has id': (r) => {
        try {
          return !!JSON.parse(r.body).id;
        } catch (_) {
          return false;
        }
      },
      'POST /api/streams — status active': (r) => {
        try {
          return JSON.parse(r.body).status === 'active';
        } catch (_) {
          return false;
        }
      },
    });
  }
  streamsCreateLatency.add(res.timings.duration);

  // --- Edge case: empty body ---
  const emptyRes = http.post(`${BASE_URL}/api/streams`, '{}', {
    ...JSON_HEADERS,
    tags: { endpoint: 'streams_create' },
  });
  // Current implementation defaults all fields and returns 201.
  // This check documents current behavior; tighten when validation is added.
  const emptyOk = check(emptyRes, {
    'POST /api/streams (empty) — no 5xx': (r) => r.status < 500,
  });
  errorRate.add(!emptyOk);
  streamsCreateLatency.add(emptyRes.timings.duration);

  sleep(0.5);
}
