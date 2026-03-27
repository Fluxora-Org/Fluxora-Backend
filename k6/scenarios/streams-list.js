import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL } from '../config.js';
import { checkResponse, streamsListLatency } from '../helpers.js';

/**
 * Exercises GET /api/streams (list all streams).
 *
 * Trust boundary: public internet clients.
 * Expected behavior: always returns 200 with a JSON array (may be empty).
 * Failure modes:
 *   - Dependency outage (future DB) → should return 503 with error body.
 *   - Partial data → must never return truncated JSON.
 */
export default function streamsListScenario() {
  const res = http.get(`${BASE_URL}/api/streams`, {
    tags: { endpoint: 'streams_list' },
  });

  checkResponse(res, 200, 'GET /api/streams');
  streamsListLatency.add(res.timings.duration);

  sleep(0.5);
}
