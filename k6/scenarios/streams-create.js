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
 * Trust boundary: public internet clients (auth deferred).
 *
 * Contract:
 *   - Requires Idempotency-Key header (1–128 chars, [A-Za-z0-9:_-])
 *   - depositAmount and ratePerSecond must be decimal strings
 *   - 201 response body: { id, sender, recipient, depositAmount, ratePerSecond,
 *                          startTime, endTime, status }
 *   - Amounts in response are decimal strings (never native JSON numbers)
 *
 * Failure modes tested:
 *   - Missing Idempotency-Key → 400 VALIDATION_ERROR
 *   - Empty body              → 400 VALIDATION_ERROR
 */
export default function streamsCreateScenario() {
  counter++;

  // Unique idempotency key per iteration — prevents replay collisions across VUs.
  const idempotencyKey = `k6-${__VU}-${__ITER}`;

  // --- Happy path: well-formed payload with required Idempotency-Key ---
  const payload = makeStreamPayload(counter);
  const res = http.post(`${BASE_URL}/api/streams`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    tags: { endpoint: 'streams_create' },
  });

  const passed = checkResponse(res, 201, 'POST /api/streams (valid)');
  if (passed) {
    check(res, {
      'POST /api/streams — has id': (r) => {
        try { return typeof JSON.parse(r.body).id === 'string'; } catch (_) { return false; }
      },
      'POST /api/streams — status active': (r) => {
        try { return JSON.parse(r.body).status === 'active'; } catch (_) { return false; }
      },
      // Decimal-string serialization policy: amounts must be strings, not numbers.
      'POST /api/streams — depositAmount is decimal string': (r) => {
        try { return typeof JSON.parse(r.body).depositAmount === 'string'; } catch (_) { return false; }
      },
      'POST /api/streams — ratePerSecond is decimal string': (r) => {
        try { return typeof JSON.parse(r.body).ratePerSecond === 'string'; } catch (_) { return false; }
      },
    });
  }
  streamsCreateLatency.add(res.timings.duration);

  // --- Missing Idempotency-Key → 400 ---
  const noKeyRes = http.post(`${BASE_URL}/api/streams`, payload, {
    ...JSON_HEADERS,
    tags: { endpoint: 'streams_create' },
  });
  const noKeyOk = check(noKeyRes, {
    'POST /api/streams (no idempotency key) — status 400': (r) => r.status === 400,
  });
  errorRate.add(!noKeyOk);
  streamsCreateLatency.add(noKeyRes.timings.duration);

  // --- Empty body → 400 ---
  const emptyRes = http.post(`${BASE_URL}/api/streams`, '{}', {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `${idempotencyKey}-empty`,
    },
    tags: { endpoint: 'streams_create' },
  });
  const emptyOk = check(emptyRes, {
    'POST /api/streams (empty body) — status 400': (r) => r.status === 400,
  });
  errorRate.add(!emptyOk);
  streamsCreateLatency.add(emptyRes.timings.duration);

  sleep(0.5);
}
