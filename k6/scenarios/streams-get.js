import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../config.js';
import { checkResponse, errorRate, streamsGetLatency } from '../helpers.js';

/**
 * Exercises GET /api/streams/:id.
 *
 * Two paths tested:
 *   1. Existing stream → 200 with full stream object.
 *   2. Non-existent stream → 404 with { error: "Stream not found" }.
 *
 * Failure mode: If future DB is down the endpoint should 503, not hang.
 */
export default function streamsGetScenario() {
  // --- Happy path: fetch a known stream seeded earlier in the run ---
  // The mixed scenario creates streams; pick up an ID from the list.
  const listRes = http.get(`${BASE_URL}/api/streams`, {
    tags: { endpoint: 'streams_list' },
  });

  let streams = [];
  try {
    const body = JSON.parse(listRes.body);
    streams = body.streams || [];
  } catch (_) {
    /* list empty or unparseable — skip happy path */
  }

  if (streams.length > 0) {
    const target = streams[Math.floor(Math.random() * streams.length)];
    const res = http.get(`${BASE_URL}/api/streams/${target.id}`, {
      tags: { endpoint: 'streams_get' },
    });
    checkResponse(res, 200, 'GET /api/streams/:id (exists)');
    streamsGetLatency.add(res.timings.duration);
  }

  // --- 404 path: request a stream ID that cannot exist ---
  const res404 = http.get(`${BASE_URL}/api/streams/nonexistent-${Date.now()}`, {
    tags: { endpoint: 'streams_get' },
  });
  const ok404 = check(res404, {
    'GET /api/streams/:id (missing) — status 404': (r) => r.status === 404,
    'GET /api/streams/:id (missing) — error body': (r) => {
      try {
        return JSON.parse(r.body).error === 'Stream not found';
      } catch (_) {
        return false;
      }
    },
  });
  errorRate.add(!ok404);
  streamsGetLatency.add(res404.timings.duration);

  sleep(0.5);
}
