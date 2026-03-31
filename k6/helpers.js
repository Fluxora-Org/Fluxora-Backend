import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

/**
 * Custom metrics shared across scenarios.
 */
export const errorRate = new Rate('fluxora_errors');
export const healthLatency = new Trend('fluxora_health_latency', true);
export const streamsListLatency = new Trend('fluxora_streams_list_latency', true);
export const streamsGetLatency = new Trend('fluxora_streams_get_latency', true);
export const streamsCreateLatency = new Trend('fluxora_streams_create_latency', true);

/**
 * Standard JSON headers for POST requests.
 */
export const JSON_HEADERS = {
  headers: { 'Content-Type': 'application/json' },
};

/**
 * Run common response checks and record to the error rate metric.
 *
 * @param {import('k6/http').RefinedResponse} res
 * @param {number} expectedStatus
 * @param {string} label  Human-readable label for check output
 * @returns {boolean} true if all checks passed
 */
export function checkResponse(res, expectedStatus, label) {
  const passed = check(res, {
    [`${label} — status ${expectedStatus}`]: (r) => r.status === expectedStatus,
    [`${label} — has body`]: (r) => r.body && r.body.length > 0,
  });
  errorRate.add(!passed);
  return passed;
}

/**
 * Generate a realistic-looking stream creation payload.
 *
 * @param {number} idx  Unique index to make payloads distinguishable
 */
export function makeStreamPayload(idx) {
  return JSON.stringify({
    sender: `GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890SENDER${idx}`,
    recipient: `GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890RECIP${idx}`,
    depositAmount: `${(1000 + idx * 10).toFixed(7)}`,
    ratePerSecond: `${(0.001 + idx * 0.0001).toFixed(7)}`,
    startTime: Math.floor(Date.now() / 1000),
  });
}
