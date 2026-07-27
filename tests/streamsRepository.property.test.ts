/**
 * Property-based tests for streamRepository.findWithCursor (PostgreSQL-backed).
 *
 * This test suite uses fast-check to generate randomized datasets and query parameters,
 * validating pagination invariants (gaps/duplicates, completeness, order stability).
 *
 * All PG pool interactions are mocked — no live database is required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';

// ── Mock pool query implementation ───────────────────────────────────────────
let currentDataset: Record<string, any>[] = [];

const mockQuery = vi.fn(async (pool: unknown, sql: string, queryParams: unknown[]) => {
  const isCount = sql.toUpperCase().includes('COUNT(*)');

  // Extract SQL WHERE conditions to apply filters
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s*LIMIT|$)/i);
  let filtered = [...currentDataset];

  if (whereMatch && whereMatch[1]) {
    const whereClause = whereMatch[1];
    const conditionStrings = whereClause.split(/\s+AND\s+/i);

    for (const cond of conditionStrings) {
      // Matches pattern "column = $idx" or "column > $idx"
      const match = cond.match(/(\w+)\s*([=>])\s*\$(\d+)/);
      if (match) {
        const column = match[1]!;
        const operator = match[2]!;
        const paramIdx = parseInt(match[3]!, 10);
        const value = queryParams[paramIdx - 1];

        filtered = filtered.filter((row) => {
          const rowVal = row[column];
          if (operator === '=') {
            return String(rowVal) === String(value);
          } else if (operator === '>') {
            return String(rowVal) > String(value);
          }
          return true;
        });
      }
    }
  }

  if (isCount) {
    return { rows: [{ count: String(filtered.length) }] };
  }

  // Cursor pagination orders by id ASC
  filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Handle LIMIT $N parameter (which corresponds to limit + 1 in findWithCursor)
  const limitMatch = sql.match(/LIMIT\s+\$(\d+)/i);
  if (limitMatch && limitMatch[1]) {
    const limitParamIdx = parseInt(limitMatch[1]!, 10);
    const limitVal = queryParams[limitParamIdx - 1] as number;
    filtered = filtered.slice(0, limitVal);
  }

  return { rows: filtered };
});

const mockGetReadPool = vi.fn();

// ── Mock all repository dependencies ──────────────────────────────────────────
vi.mock('../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (pool: any, sql: any, params?: any) => mockQuery(pool, sql, params),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) {
      super(d ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
}));

vi.mock('../src/db/replicaPool.js', () => ({
  getReadPool: (...args: unknown[]) => mockGetReadPool(...args),
}));

vi.mock('../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({
    pgcryptoKey: 'test-key-32-bytes-padding-xxxxxx',
    pgcryptoKeyPrevious: undefined,
  })),
  initializeConfig: vi.fn(),
}));

vi.mock('../src/pii/pgcryptoEncryption.js', () => ({
  computeAddressHashes: vi.fn(() => ({ current: 'hash', previous: undefined })),
}));

vi.mock('../src/tracing/hooks.js', () => ({
  enrichActiveSpanWithStream: vi.fn(),
}));

vi.mock('../src/db/queries/streams.js', () => ({
  encryptAddressValue: vi.fn((col: number) => `$${col}`),
  streamSelectColumns: vi.fn(() => '*'),
  senderAddressFilterCondition: vi.fn((f: number) => `sender_address = $${f}`),
  recipientAddressFilterCondition: vi.fn((f: number) => `recipient_address = $${f}`),
}));

vi.mock('../src/metrics/dbMetrics.js', () => ({
  dbQueryDurationSeconds: { startTimer: vi.fn(() => vi.fn()) },
}));

vi.mock('../src/utils/logger.js', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { streamRepository } from '../src/db/repositories/streamRepository.js';

// ── Fast-check Arbitrary / Generator for Stream Records ─────────────────────
const streamRecordArb = fc.record({
  id: fc.uuid().map((uuid) => `stream-${uuid}`),
  sender_address: fc.constant('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'),
  recipient_address: fc.constant('GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR'),
  amount: fc.constant('1000'),
  streamed_amount: fc.constant('0'),
  remaining_amount: fc.constant('1000'),
  rate_per_second: fc.constant('10'),
  start_time: fc.constant('1700000000'),
  end_time: fc.constant('0'),
  status: fc.constantFrom('active', 'paused', 'completed', 'cancelled'),
  contract_id: fc.constantFrom('api-created', 'contract-1', 'contract-2'),
  transaction_hash: fc.string({
    minLength: 64,
    maxLength: 64,
    unit: fc.constantFrom(...'0123456789abcdef'.split('')),
  }),
  event_index: fc.integer({ min: 0, max: 10 }),
  created_at: fc.date(),
  updated_at: fc.date(),
});

describe('streamRepository.findWithCursor - Property-Based Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReadPool.mockResolvedValue({});
    currentDataset = [];
  });

  it('correctly pages through datasets with a fixed seed', async () => {
    // Fixed seed ensures deterministic run execution
    const runOptions = { seed: 42, numRuns: 100 };

    await fc.assert(
      fc.asyncProperty(
        fc.array(streamRecordArb, { minLength: 0, maxLength: 100 }),
        fc.integer({ min: 1, max: 20 }),
        fc.boolean(),
        async (rawStreams, limit, includeTotal) => {
          // Inject duplicate created_at timestamps to simulate tied-timestamp datasets
          const sharedDate = new Date('2026-06-26T12:00:00.000Z');
          const streams = rawStreams.map((s, idx) => {
            // Assign unique ID to prevent database primary key collisions
            const uniqueId = `stream-${idx}-${s.id.slice(7)}`;
            const createdAt = idx % 2 === 0 ? sharedDate : s.created_at;
            return {
              ...s,
              id: uniqueId,
              created_at: createdAt,
              updated_at: createdAt,
            };
          });

          // Load generated streams into the mocked query layer
          currentDataset = streams;

          // ── Pagination Traversal ───────────────────────────────────────────
          const fetchedStreams: any[] = [];
          const pageSizes: number[] = [];
          let hasMore = true;
          let afterId: string | undefined = undefined;
          let pagesCount = 0;
          const maxPages = streams.length + 5; // Safety bound

          while (hasMore && pagesCount < maxPages) {
            const result = await streamRepository.findWithCursor({}, limit, afterId, includeTotal);

            // Assert: Returned stream count per page must respect limit bounds
            expect(result.streams.length).toBeLessThanOrEqual(limit);
            pageSizes.push(result.streams.length);

            // Accumulate returned streams
            fetchedStreams.push(...result.streams);

            // Assert: verify hasMore matches count of remaining items in sorted dataset
            const sortedDataset = [...streams].sort((a, b) =>
              a.id < b.id ? -1 : a.id > b.id ? 1 : 0
            );
            const lastIndex = afterId ? sortedDataset.findIndex((s) => s.id === afterId) : -1;
            const remainingCount = sortedDataset.length - (lastIndex + 1);
            const expectedHasMore = remainingCount > limit;
            expect(result.hasMore).toBe(expectedHasMore);

            // Assert: if includeTotal is true, returned total equals original count
            if (includeTotal) {
              expect(result.total).toBe(streams.length);
            } else {
              expect(result.total).toBeUndefined();
            }

            // Set up cursor for next page
            if (result.streams.length > 0) {
              afterId = result.streams[result.streams.length - 1]!.id;
            } else {
              afterId = undefined;
            }
            hasMore = result.hasMore;
            pagesCount++;
          }

          // ── Invariant Assertions ───────────────────────────────────────────

          // Assert: Every row in the database is fetched exactly once
          expect(fetchedStreams.length).toBe(streams.length);

          // Assert: No gaps and no duplicates (all original IDs are retrieved)
          const originalIds = new Set(streams.map((s) => s.id));
          const fetchedIds = fetchedStreams.map((s) => s.id);
          expect(new Set(fetchedIds).size).toBe(fetchedIds.length); // duplicates verification
          for (const id of fetchedIds) {
            expect(originalIds.has(id)).toBe(true); // gaps verification
          }

          // Assert: Ordering remains stable (strictly sorted by id ASC) across page boundaries
          for (let i = 1; i < fetchedStreams.length; i++) {
            expect(fetchedStreams[i - 1]!.id < fetchedStreams[i]!.id).toBe(true);
          }

          // Assert: All pages except the last one must be fully filled with `limit` items
          for (let i = 0; i < pageSizes.length - 1; i++) {
            expect(pageSizes[i]).toBe(limit);
          }
        }
      ),
      runOptions
    );
  });

  it('handles empty datasets correctly', async () => {
    currentDataset = [];

    const result = await streamRepository.findWithCursor({}, 10, undefined, true);
    expect(result.streams).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(0);
  });

  it('handles single-page datasets correctly', async () => {
    const singleRow = {
      id: 'stream-single',
      sender_address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
      amount: '1000',
      streamed_amount: '0',
      remaining_amount: '1000',
      rate_per_second: '10',
      start_time: 1700000000,
      end_time: 0,
      status: 'active',
      contract_id: 'api-created',
      transaction_hash: 'h',
      event_index: 0,
      created_at: new Date('2024-01-01T00:00:00Z'),
      updated_at: new Date('2024-01-01T00:00:00Z'),
    };
    currentDataset = [singleRow];

    const result = await streamRepository.findWithCursor({}, 10, undefined, true);
    expect(result.streams).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(1);
    expect(result.streams[0]!.id).toBe('stream-single');
  });
});
