/**
 * Standalone validation script for issue #948 — WebSocket graceful shutdown
 * close reason codes.
 *
 * Run with: node --loader ts-node/esm tests/ws/hub.gracefulClose.validate.mjs
 * Or: ts-node --esm tests/ws/hub.gracefulClose.validate.mjs
 *
 * This script validates the contract of WS_CLOSE_REASONS and
 * WS_CLOSE_CODE_GOING_AWAY without relying on the vitest runner.
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ── Import hub exports ────────────────────────────────────────────────────────

const {
  WS_CLOSE_REASONS,
  WS_CLOSE_CODE_GOING_AWAY,
} = await import('../../src/ws/hub.js');

const {
  SSE_CLOSE_REASONS,
} = await import('../../src/streams/sseEmitter.js');

// ── WS_CLOSE_CODE_GOING_AWAY ──────────────────────────────────────────────────

section('WS_CLOSE_CODE_GOING_AWAY');
assert('is exactly 1001', WS_CLOSE_CODE_GOING_AWAY === 1001);
assert('is a number', typeof WS_CLOSE_CODE_GOING_AWAY === 'number');

// ── WS_CLOSE_REASONS ──────────────────────────────────────────────────────────

section('WS_CLOSE_REASONS');
assert('SERVER_SHUTDOWN is "server_shutdown"', WS_CLOSE_REASONS.SERVER_SHUTDOWN === 'server_shutdown');
assert('MAX_DURATION is "max_duration"', WS_CLOSE_REASONS.MAX_DURATION === 'max_duration');
assert('has exactly two keys', Object.keys(WS_CLOSE_REASONS).length === 2);

// ── Parity with SSE_CLOSE_REASONS ─────────────────────────────────────────────

section('Parity with SSE_CLOSE_REASONS');
assert(
  'SERVER_SHUTDOWN matches SSE counterpart',
  WS_CLOSE_REASONS.SERVER_SHUTDOWN === SSE_CLOSE_REASONS.SERVER_SHUTDOWN,
);
assert(
  'MAX_DURATION matches SSE counterpart',
  WS_CLOSE_REASONS.MAX_DURATION === SSE_CLOSE_REASONS.MAX_DURATION,
);

// ── Close-frame reason payload ────────────────────────────────────────────────

section('Close-frame reason payload');
const payload = JSON.stringify({ reason: WS_CLOSE_REASONS.SERVER_SHUTDOWN });
let parsedPayload;
try {
  parsedPayload = JSON.parse(payload);
  assert('is valid JSON', true);
} catch {
  assert('is valid JSON', false, 'JSON.parse threw');
}
assert(
  'reason field equals SERVER_SHUTDOWN',
  parsedPayload?.reason === WS_CLOSE_REASONS.SERVER_SHUTDOWN,
);
const byteLen = Buffer.byteLength(payload, 'utf8');
assert(
  `is ≤ 125 bytes (RFC 6455 §5.5 limit), actual: ${byteLen}`,
  byteLen <= 125,
);
assert(
  'contains only the `reason` field',
  JSON.stringify(Object.keys(parsedPayload ?? {})) === '["reason"]',
);
assert('no auth tokens or secrets in payload', !/Bearer|token|secret|key|auth/i.test(payload));
assert('no stack traces in payload', !/Error|stack|at\s+\w+/.test(payload));
assert('no URL patterns in payload', !/http|localhost|127\.0\.0\.1/i.test(payload));
assert(
  'is deterministic (same output on repeated calls)',
  JSON.stringify({ reason: WS_CLOSE_REASONS.SERVER_SHUTDOWN }) === payload,
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All assertions passed ✓');
}
