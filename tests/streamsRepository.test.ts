/**
 * Unit tests for streamRepository (PostgreSQL-backed).
 *
 * All pg pool interactions are mocked — no real database required.
 * Tests cover: upsert idempotency, getById, getByEvent, findWithCursor,
 * updateStream (status transitions), countByStatus, and error propagation.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ── Mock the pool module before importing the repository ─────────────────────
const mockQuery = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  getPool:           vi.fn(() => ({})),
  query:             (...args: unknown[]) => mockQuery(...args),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() { super('pool exhausted'); this.name = 'PoolExhaustedError'; }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) { super(d ?? 'duplicate'); this.name = 'DuplicateEntryError'; }
  },
}));

import { streamRepository } from '../src/db/repositories/streamRepository.js';
import type { CreateStreamInput, UpdateStreamInput } from '../src/db/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TX_HASH = 'a'.repeat(64);

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id:                'stream-' + TX_HASH + '-0',
    sender_address:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
    amount:            '1000',
    streamed_amount:   '0',
    remaining_amount:  '1000',
    rate_per_second:   '10',
    start_time:        '1700000000',
    end_time:          '0',
    status:            'active',
    contract_id:       'api-created',
    transaction_hash:  TX_HASH,
    event_index:       0,
    created_at:        new Date('2024-01-01T00:00:00Z'),
    updated_at:        new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateStreamInput> = {}): CreateStreamInput {
  return {
    id:                'stream-' + TX_HASH + '-0',
    sender_address:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
    amount:            '1000',
    streamed_amount:   '0',
    remaining_amount:  '1000',
    rate_per_second:   '10',
    start_time:        1700000000,
    end_time:          0,
    contract_id:       'api-created',
    transaction_hash:  TX_HASH,
    event_index:       0,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function queryReturnsRows(rows: Record<string, unknown>[]) {
  mockQuery.mockResolvedValueOnce({ rows });
}

function queryReturnsEmpty() {
  mockQuery.mockResolvedValueOnce({ rows: [] });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('streamRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── upsertStream ────────────────────────────────────────────────────────────

  describe('upsertStream', () => {
    it('creates a new stream and returns created=true', async () => {
      const row = makeRow();
      queryReturnsRows([row]); // INSERT … RETURNING *

      const result = await streamRepository.upsertStream(makeInput());

      expect(result.created).toBe(true);
      expect(result.stream.id).toBe(row['id']);
      expect(result.stream.amount).toBe('1000');
      expect(result.stream.start_time).toBe(1700000000); // bigint coerced to number
    });

    it('returns created=false when event already exists (idempotent)', async () => {
      queryReturnsEmpty();                // INSERT returns nothing (conflict)
      queryReturnsRows([makeRow()]);      // getById fallback

      const result = await streamRepository.upsertStream(makeInput());

      expect(result.created).toBe(false);
      expect(result.stream.id).toBeTruthy();
    });

    it('falls back to getByEvent when getById returns nothing', async () => {
      queryReturnsEmpty();           // INSERT conflict
      queryReturnsEmpty();           // getById → not found
      queryReturnsRows([makeRow()]); // getByEvent → found

      const result = await streamRepository.upsertStream(makeInput());
      expect(result.created).toBe(false);
    });

    it('throws when both getById and getByEvent return nothing after conflict', async () => {
      queryReturnsEmpty(); // INSERT conflict
      queryReturnsEmpty(); // getById
      queryReturnsEmpty(); // getByEvent

      await expect(streamRepository.upsertStream(makeInput())).rejects.toThrow(
        'Idempotency conflict',
      );
    });

    it('preserves decimal-string amounts exactly', async () => {
      const row = makeRow({ amount: '0.0000001', rate_per_second: '0.0000116' });
      queryReturnsRows([row]);

      const result = await streamRepository.upsertStream(
        makeInput({ amount: '0.0000001', rate_per_second: '0.0000116' }),
      );

      expect(result.stream.amount).toBe('0.0000001');
      expect(result.stream.rate_per_second).toBe('0.0000116');
    });
  });

  // ── getById ─────────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns a stream record when found', async () => {
      queryReturnsRows([makeRow()]);
      const record = await streamRepository.getById('stream-' + TX_HASH + '-0');
      expect(record).toBeDefined();
      expect(record!.status).toBe('active');
    });

    it('returns undefined when not found', async () => {
      queryReturnsEmpty();
      const record = await streamRepository.getById('nonexistent');
      expect(record).toBeUndefined();
    });

    it('coerces bigint start_time / end_time to number', async () => {
      queryReturnsRows([makeRow({ start_time: '1700000000', end_time: '1800000000' })]);
      const record = await streamRepository.getById('x');
      expect(typeof record!.start_time).toBe('number');
      expect(typeof record!.end_time).toBe('number');
      expect(record!.start_time).toBe(1700000000);
      expect(record!.end_time).toBe(1800000000);
    });
  });

  // ── getByEvent ──────────────────────────────────────────────────────────────

  describe('getByEvent', () => {
    it('returns a stream when found by tx hash + event index', async () => {
      queryReturnsRows([makeRow()]);
      const record = await streamRepository.getByEvent(TX_HASH, 0);
      expect(record).toBeDefined();
    });

    it('returns undefined when not found', async () => {
      queryReturnsEmpty();
      const record = await streamRepository.getByEvent('deadbeef', 99);
      expect(record).toBeUndefined();
    });
  });

  // ── updateStream ────────────────────────────────────────────────────────────

  describe('updateStream', () => {
    it('updates status from active to cancelled', async () => {
      queryReturnsRows([makeRow()]);                              // getById
      queryReturnsRows([makeRow({ status: 'cancelled' })]);      // UPDATE RETURNING

      const updated = await streamRepository.updateStream('stream-x', { status: 'cancelled' });
      expect(updated.status).toBe('cancelled');
    });

    it('updates status from active to paused', async () => {
      queryReturnsRows([makeRow()]);
      queryReturnsRows([makeRow({ status: 'paused' })]);

      const updated = await streamRepository.updateStream('stream-x', { status: 'paused' });
      expect(updated.status).toBe('paused');
    });

    it('rejects invalid transition: completed → active', async () => {
      queryReturnsRows([makeRow({ status: 'completed' })]);

      await expect(
        streamRepository.updateStream('stream-x', { status: 'active' }),
      ).rejects.toThrow('Invalid status transition');
    });

    it('rejects invalid transition: cancelled → paused', async () => {
      queryReturnsRows([makeRow({ status: 'cancelled' })]);

      await expect(
        streamRepository.updateStream('stream-x', { status: 'paused' }),
      ).rejects.toThrow('Invalid status transition');
    });

    it('throws when stream not found', async () => {
      queryReturnsEmpty(); // getById

      await expect(
        streamRepository.updateStream('nonexistent', { status: 'cancelled' }),
      ).rejects.toThrow('Stream not found');
    });

    it('updates streamed_amount and remaining_amount', async () => {
      queryReturnsRows([makeRow()]);
      queryReturnsRows([makeRow({ streamed_amount: '500', remaining_amount: '500' })]);

      const updated = await streamRepository.updateStream('stream-x', {
        streamed_amount:  '500',
        remaining_amount: '500',
      });
      expect(updated.streamed_amount).toBe('500');
      expect(updated.remaining_amount).toBe('500');
    });
  });

  // ── findWithCursor ──────────────────────────────────────────────────────────

  describe('findWithCursor', () => {
    it('returns empty list when no streams exist', async () => {
      queryReturnsRows([]); // data query (no total)

      const result = await streamRepository.findWithCursor({}, 50);
      expect(result.streams).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('returns streams and detects hasMore', async () => {
      // limit=2, fetch limit+1=3 rows → hasMore=true
      const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })];
      queryReturnsRows(rows);

      const result = await streamRepository.findWithCursor({}, 2);
      expect(result.streams).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('includes total when includeTotal=true', async () => {
      queryReturnsRows([makeRow()]); // data
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '42' }] }); // count

      const result = await streamRepository.findWithCursor({}, 50, undefined, true);
      expect(result.total).toBe(42);
    });

    it('does not include total when includeTotal=false', async () => {
      queryReturnsRows([makeRow()]);

      const result = await streamRepository.findWithCursor({}, 50, undefined, false);
      expect(result.total).toBeUndefined();
    });

    it('applies afterId cursor correctly', async () => {
      queryReturnsRows([makeRow({ id: 'stream-b' })]);

      const result = await streamRepository.findWithCursor({}, 50, 'stream-a');
      expect(result.streams[0]!.id).toBe('stream-b');
    });
  });

  // ── countByStatus ───────────────────────────────────────────────────────────

  describe('countByStatus', () => {
    it('returns zero counts when table is empty', async () => {
      queryReturnsRows([]);

      const counts = await streamRepository.countByStatus();
      expect(counts.active).toBe(0);
      expect(counts.paused).toBe(0);
      expect(counts.completed).toBe(0);
      expect(counts.cancelled).toBe(0);
    });

    it('aggregates counts by status', async () => {
      queryReturnsRows([
        { status: 'active',    count: '5' },
        { status: 'paused',    count: '2' },
        { status: 'cancelled', count: '1' },
      ]);

      const counts = await streamRepository.countByStatus();
      expect(counts.active).toBe(5);
      expect(counts.paused).toBe(2);
      expect(counts.cancelled).toBe(1);
      expect(counts.completed).toBe(0);
    });
  });

  // ── error propagation ───────────────────────────────────────────────────────

  describe('error propagation', () => {
    it('propagates unexpected DB errors from getById', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      await expect(streamRepository.getById('x')).rejects.toThrow('connection refused');
    });

    it('propagates unexpected DB errors from upsertStream', async () => {
      mockQuery.mockRejectedValueOnce(new Error('syntax error'));
      await expect(streamRepository.upsertStream(makeInput())).rejects.toThrow('syntax error');
    });
  });
});
