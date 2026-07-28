/**
 * SQL-injection regression suite for streamRepository.
 *
 * Every public method that accepts user-controlled input is exercised with
 * adversarial payloads from sqliPayloads.ts.  The suite asserts that
 * node-postgres parameterized queries prevent injection — payloads must
 * either produce an empty/undefined result (no row with that literal id
 * exists) or a well-typed object, and must never throw a PostgreSQL syntax
 * error caused by the payload being interpolated into SQL.
 *
 * Pool and config are fully mocked so no real database is required and the
 * tests run deterministically in CI.
 *
 * Security notes:
 *  - The pgcrypto key is sourced from the mocked config, never from the
 *    environment, so no real secret is needed.
 *  - Key values in this file are test-only fixtures that satisfy the 32-char
 *    minimum length check; they are not used for real encryption.
 */
import { describe, it, beforeAll, expect, vi } from 'vitest';
import { sqliPayloads } from './fixtures/sqliPayloads.js';

// ── Mocks must be registered before the repository is imported ───────────────

const mockQuery        = vi.fn();
const mockGetReadPool  = vi.fn();

vi.mock('../../src/db/pool.js', () => ({
  getPool:            vi.fn(() => ({})),
  query:              (...args: unknown[]) => mockQuery(...args),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) { super(d ?? 'duplicate'); this.name = 'DuplicateEntryError'; }
  },
}));

vi.mock('../../src/db/replicaPool.js', () => ({
  getReadPool: (...args: unknown[]) => mockGetReadPool(...args),
}));

// Provide a valid pgcrypto key so resolvePgcryptoKeys() does not throw.
// The key never reaches a real DB — it is only threaded into the parameterized
// query as a bound value, which is exactly what these tests want to verify.
vi.mock('../../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({
    pgcryptoKey:         'sqli-test-key-32-bytes-padding-xx',
    pgcryptoKeyPrevious: undefined,
  })),
  initializeConfig: vi.fn(),
}));

vi.mock('../../src/pii/pgcryptoEncryption.js', () => ({
  computeAddressHashes: vi.fn(() => ({ current: 'hash', previous: undefined })),
}));

vi.mock('../../src/tracing/hooks.js', () => ({
  enrichActiveSpanWithStream: vi.fn(),
}));

vi.mock('../../src/db/queries/streams.js', () => ({
  encryptAddressValue:           vi.fn((col: number) => `$${col}`),
  streamSelectColumns:           vi.fn(() => '*'),
  senderAddressFilterCondition:  vi.fn((f: number) => `sender_address = $${f}`),
  recipientAddressFilterCondition: vi.fn((f: number) => `recipient_address = $${f}`),
}));

vi.mock('../../src/metrics/dbMetrics.js', () => ({
  dbQueryDurationSeconds: { startTimer: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

import { streamRepository } from '../../src/db/repositories/streamRepository.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Make the mock pool always return an empty result set. */
function returnsEmpty() {
  mockQuery.mockResolvedValue({ rows: [] });
  mockGetReadPool.mockResolvedValue({});
}

const TX_HASH = 'b'.repeat(64);

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:                'stream-sqli-test',
    sender_address:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
    amount:            '100',
    streamed_amount:   '0',
    remaining_amount:  '100',
    rate_per_second:   '1',
    start_time:        '1700000000',
    end_time:          '0',
    status:            'active',
    contract_id:       'test-contract',
    transaction_hash:  TX_HASH,
    event_index:       0,
    created_at:        new Date('2024-01-01'),
    updated_at:        new Date('2024-01-01'),
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('streamRepository SQLi regression suite', () => {
  beforeAll(() => {
    // Pool mock is set up per-test via returnsEmpty() / explicit
    // mockQuery.mockResolvedValue(...) calls below.
  });

  // ── getById ─────────────────────────────────────────────────────────────────
  //
  // The payload lands in $1 (the id bind parameter).  Parameterized queries
  // must prevent any SQL structural modification regardless of payload content.

  describe('getById', () => {
    for (const payload of sqliPayloads) {
      it(`treats adversarial id payload as a literal string: [${payload}]`, async () => {
        returnsEmpty();

        const res = await streamRepository.getById(payload);

        // An adversarial id should produce undefined (no row with that literal
        // id exists) — never a populated result set from an injected SELECT.
        expect(res).toBeUndefined();

        // The payload must appear verbatim as the first bound parameter ($1),
        // not interpolated into the SQL string.
        const sqlCall = mockQuery.mock.calls.at(-1) as [unknown, string, unknown[]];
        const sql    = sqlCall[1];
        const params = sqlCall[2];

        // Confirm the query is parameterized: the payload must NOT appear
        // literally in the SQL string itself.
        expect(sql).not.toContain(payload);

        // The payload must appear as a bound value in params[0].
        expect(params[0]).toBe(payload);

        // Keys must be bound params too — never interpolated.
        expect(typeof params[1]).toBe('string'); // current key as $2
      });
    }
  });

  // ── getByEvent ───────────────────────────────────────────────────────────────
  //
  // The payload lands in $1 (transaction_hash).

  describe('getByEvent', () => {
    for (const payload of sqliPayloads) {
      it(`treats adversarial transaction_hash as a literal string: [${payload}]`, async () => {
        returnsEmpty();

        const res = await streamRepository.getByEvent(payload, 0);

        expect(res).toBeUndefined();

        const sqlCall = mockQuery.mock.calls.at(-1) as [unknown, string, unknown[]];
        const sql    = sqlCall[1];
        const params = sqlCall[2];

        expect(sql).not.toContain(payload);
        expect(params[0]).toBe(payload);
      });
    }
  });

  // ── findWithCursor ───────────────────────────────────────────────────────────
  //
  // Payload is passed as a filter value (contract_id).

  describe('findWithCursor', () => {
    for (const payload of sqliPayloads) {
      it(`treats adversarial contract_id filter as a literal string: [${payload}]`, async () => {
        returnsEmpty();

        const res = await streamRepository.findWithCursor({ contract_id: payload }, 10);

        expect(res.streams).toHaveLength(0);
        expect(res.hasMore).toBe(false);

        const sqlCall = mockQuery.mock.calls.at(-1) as [unknown, string, unknown[]];
        const sql    = sqlCall[1];

        // The payload must not appear literally in the SQL.
        expect(sql).not.toContain(payload);
      });
    }
  });

  // ── updateStream ─────────────────────────────────────────────────────────────
  //
  // Payload is passed as the stream id.  updateStream first calls getById
  // (returning a live row so it can proceed), then issues an UPDATE.

  describe('updateStream', () => {
    for (const payload of sqliPayloads) {
      it(`treats adversarial id in updateStream as a literal string: [${payload}]`, async () => {
        // getById needs to return a row so that updateStream can validate the
        // status transition; otherwise it throws "Stream not found" before
        // reaching the UPDATE — which would hide any injection risk in the UPDATE.
        mockGetReadPool.mockResolvedValue({});
        mockQuery
          .mockResolvedValueOnce({ rows: [makeRow({ id: payload })] })  // getById
          .mockResolvedValueOnce({ rows: [makeRow({ id: payload, status: 'cancelled' })] }); // UPDATE RETURNING

        const res = await streamRepository.updateStream(payload, { status: 'cancelled' });

        expect(res).toBeDefined();
        expect(res.status).toBe('cancelled');

        // Check both SQL calls (getById SELECT + UPDATE) for literal payload leakage.
        for (const call of mockQuery.mock.calls as [unknown, string, unknown[]][]) {
          const sql = call[1];
          expect(sql).not.toContain(payload);
        }
      });
    }
  });

  // ── upsertStream ─────────────────────────────────────────────────────────────
  //
  // Payload appears in contract_id — a user-controlled field that flows into
  // a bound parameter in the INSERT.

  describe('upsertStream', () => {
    for (const payload of sqliPayloads) {
      it(`treats adversarial contract_id in upsertStream as a literal string: [${payload}]`, async () => {
        mockGetReadPool.mockResolvedValue({});
        // INSERT … RETURNING returns one row
        mockQuery.mockResolvedValueOnce({ rows: [makeRow({ contract_id: payload })] });

        const result = await streamRepository.upsertStream({
          id:                'sqli-test-id',
          sender_address:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
          recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
          amount:            '100',
          streamed_amount:   '0',
          remaining_amount:  '100',
          rate_per_second:   '1',
          start_time:        1700000000,
          end_time:          0,
          contract_id:       payload,
          transaction_hash:  TX_HASH,
          event_index:       0,
        });

        expect(result.created).toBe(true);

        const sqlCall = mockQuery.mock.calls.at(-1) as [unknown, string, unknown[]];
        const sql    = sqlCall[1];

        // Payload must not appear raw in the SQL.
        expect(sql).not.toContain(payload);
      });
    }
  });
});
