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

// Valid Stellar public keys (G + 55 base32 chars, 56 chars total).
// These are well-known testnet addresses safe to use in load tests.
const STELLAR_SENDERS = [
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  'GBVVJJWAKGKF3YJKGQZQKQZQKQZQKQZQKQZQKQZQKQZQKQZQKQZQKQ',
  'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
];
const STELLAR_RECIPIENTS = [
  'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  'GDQJUTQYK2MQX2CQNQGKWPWWQJQKQZQKQZQKQZQKQZQKQZQKQZQKQZ',
];

/**
 * Generate a stream creation payload with valid Stellar addresses and
 * decimal-string amounts per the serialization policy.
 *
 * @param {number} idx  Unique index to vary amounts across VUs
 */
export function makeStreamPayload(idx) {
  const i = idx % STELLAR_SENDERS.length;
  // Amounts are decimal strings — never native JSON numbers.
  const deposit = (1000 + (idx % 100) * 10).toFixed(7);       // e.g. "1000.0000000"
  const rate    = (0.001 + (idx % 50) * 0.0001).toFixed(7);   // e.g. "0.0010000"
  return JSON.stringify({
    sender:        STELLAR_SENDERS[i],
    recipient:     STELLAR_RECIPIENTS[i],
    depositAmount: deposit,
    ratePerSecond: rate,
    startTime:     Math.floor(Date.now() / 1000),
  });
}
