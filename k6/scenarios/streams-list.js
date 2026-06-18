import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../config.js';
import { checkResponse, errorRate, streamsListLatency } from '../helpers.js';

// Valid Stellar addresses used as filter values (must match helpers.js senders/recipients).
const FILTER_SENDER    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const FILTER_RECIPIENT = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN';

/**
 * Exercises GET /api/streams.
 *
 * Trust boundary: public internet clients.
 *
 * Contract:
 *   - 200 { streams: [...], has_more: bool, next_cursor?: string }
 *   - Supports filter params: status, sender, recipient
 *   - Supports pagination params: limit, cursor, include_total
 *   - Amount fields in each stream are decimal strings
 *   - Valid filters with no matches → 200 with empty streams array (not 404)
 *   - Invalid status enum → 400 VALIDATION_ERROR
 *
 * Failure modes tested:
 *   - Filter by status=active
 *   - Filter by sender address
 *   - Filter by recipient address
 *   - Pagination with limit=5
 *   - Invalid status value → 400
 */
export default function streamsListScenario() {
  // --- Baseline: list all streams ---
  const res = http.get(`${BASE_URL}/api/streams`, {
    tags: { endpoint: 'streams_list' },
  });
  const passed = checkResponse(res, 200, 'GET /api/streams');
  if (passed) {
    check(res, {
      'GET /api/streams — has streams array': (r) => {
        try { return Array.isArray(JSON.parse(r.body).streams); } catch (_) { return false; }
      },
      'GET /api/streams — has has_more field': (r) => {
        try { return typeof JSON.parse(r.body).has_more === 'boolean'; } catch (_) { return false; }
      },
      // Decimal-string policy: if any streams exist, amounts must be strings.
      'GET /api/streams — amounts are decimal strings': (r) => {
        try {
          const { streams } = JSON.parse(r.body);
          if (!streams.length) return true;
          const s = streams[0];
          return typeof s.depositAmount === 'string' && typeof s.ratePerSecond === 'string';
        } catch (_) { return false; }
      },
    });
  }
  streamsListLatency.add(res.timings.duration);

  // --- Filter by status=active ---
  const statusRes = http.get(`${BASE_URL}/api/streams?status=active`, {
    tags: { endpoint: 'streams_list' },
  });
  const statusOk = check(statusRes, {
    'GET /api/streams?status=active — status 200': (r) => r.status === 200,
    'GET /api/streams?status=active — streams array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).streams); } catch (_) { return false; }
    },
  });
  errorRate.add(!statusOk);
  streamsListLatency.add(statusRes.timings.duration);

  // --- Filter by sender ---
  const senderRes = http.get(
    `${BASE_URL}/api/streams?sender=${encodeURIComponent(FILTER_SENDER)}`,
    { tags: { endpoint: 'streams_list' } },
  );
  const senderOk = check(senderRes, {
    'GET /api/streams?sender — status 200': (r) => r.status === 200,
    'GET /api/streams?sender — streams array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).streams); } catch (_) { return false; }
    },
  });
  errorRate.add(!senderOk);
  streamsListLatency.add(senderRes.timings.duration);

  // --- Filter by recipient ---
  const recipientRes = http.get(
    `${BASE_URL}/api/streams?recipient=${encodeURIComponent(FILTER_RECIPIENT)}`,
    { tags: { endpoint: 'streams_list' } },
  );
  const recipientOk = check(recipientRes, {
    'GET /api/streams?recipient — status 200': (r) => r.status === 200,
  });
  errorRate.add(!recipientOk);
  streamsListLatency.add(recipientRes.timings.duration);

  // --- Pagination: limit=5 ---
  const pageRes = http.get(`${BASE_URL}/api/streams?limit=5`, {
    tags: { endpoint: 'streams_list' },
  });
  const pageOk = check(pageRes, {
    'GET /api/streams?limit=5 — status 200': (r) => r.status === 200,
    'GET /api/streams?limit=5 — at most 5 streams': (r) => {
      try { return JSON.parse(r.body).streams.length <= 5; } catch (_) { return false; }
    },
  });
  errorRate.add(!pageOk);
  streamsListLatency.add(pageRes.timings.duration);

  // --- Invalid status → 400 ---
  const badStatusRes = http.get(`${BASE_URL}/api/streams?status=pending`, {
    tags: { endpoint: 'streams_list' },
  });
  const badStatusOk = check(badStatusRes, {
    'GET /api/streams?status=pending — status 400': (r) => r.status === 400,
  });
  errorRate.add(!badStatusOk);
  streamsListLatency.add(badStatusRes.timings.duration);

  sleep(0.5);
}
