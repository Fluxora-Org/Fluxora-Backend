import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL } from '../config.js';
import { checkResponse, healthLatency } from '../helpers.js';

/**
 * Exercises GET /health.
 * Expected contract:
 *   200 { status: "ok", service: "fluxora-backend", timestamp: <ISO> }
 *
 * Failure mode: any non-200 is a hard failure — operators use this
 * endpoint for readiness probes so it must be rock-solid.
 */
export default function healthScenario() {
  const res = http.get(`${BASE_URL}/health`, {
    tags: { endpoint: 'health' },
  });

  checkResponse(res, 200, 'GET /health');
  healthLatency.add(res.timings.duration);

  sleep(0.5);
}
