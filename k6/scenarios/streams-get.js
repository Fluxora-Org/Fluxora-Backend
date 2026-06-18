import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../config.js';
import { checkResponse, errorRate, streamsGetLatency } from '../helpers.js';

/**
 * Exercises GET /api/streams/:id.
 *
 * Trust boundary: public internet clients.
 *
 * Contract:
 *   - Existing stream → 200 { stream: { id, depositAmount, ratePerSecond, ... } }
 *   - Amounts in response are decimal strings (never native JSON numbers)
 *   - Non-existent stream → 404 { error: "NOT_FOUND" }
 *
 * Failure modes tested:
 *   - Happy path: fetch a stream seeded by the create scenario
 *   - 404 path: request an ID that cannot exist
 */
export default function streamsGetScenario() {
  // --- Happy path: pick a stream from the list ---
  const listRes = http.get(`${BASE_URL}/api/streams`, {
    tags: { endpoint: 'streams_list' },
  });

  let streams = [];
  try {
    const body = JSON.parse(listRes.body);
    streams = body.streams || [];
  } catch (_) { /* list empty or unparseable — skip happy path */ }

  if (streams.length > 0) {
    const target = streams[Math.floor(Math.random() * streams.length)];
    const res = http.get(`${BASE_URL}/api/streams/${target.id}`, {
      tags: { endpoint: 'streams_get' },
    });
    const passed = checkResponse(res, 200, 'GET /api/streams/:id (exists)');
    if (passed) {
      check(res, {
        // Decimal-string serialization policy: amounts must be strings.
        'GET /api/streams/:id — depositAmount is decimal string': (r) => {
          try { return typeof JSON.parse(r.body).stream.depositAmount === 'string'; } catch (_) { return false; }
        },
        'GET /api/streams/:id — ratePerSecond is decimal string': (r) => {
          try { return typeof JSON.parse(r.body).stream.ratePerSecond === 'string'; } catch (_) { return false; }
        },
      });
    }
    streamsGetLatency.add(res.timings.duration);
  }

  // --- 404 path: request a stream ID that cannot exist ---
  const res404 = http.get(`${BASE_URL}/api/streams/nonexistent-${Date.now()}`, {
    tags: { endpoint: 'streams_get' },
  });
  // Route returns { error: "NOT_FOUND" } per the documented failure mode.
  const ok404 = check(res404, {
    'GET /api/streams/:id (missing) — status 404': (r) => r.status === 404,
    'GET /api/streams/:id (missing) — error NOT_FOUND': (r) => {
      try { return JSON.parse(r.body).error === 'NOT_FOUND'; } catch (_) { return false; }
    },
  });
  errorRate.add(!ok404);
  streamsGetLatency.add(res404.timings.duration);

  sleep(0.5);
}
