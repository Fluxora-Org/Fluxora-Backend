/**
 * Property-based tests for streamRepository (PostgreSQL-backed).
 *
 * Uses fast-check to generate randomized datasets and validates the pagination
 * ordering guarantee documented on `streamRepository.findWithCursor` /
 * `streamRepository.find` in src/db/repositories/streamRepository.ts:
 *
 *   • the keyset path orders by the unique, total key `id` ASC, so no row that
 *     existed at the start of a traversal is repeated or skipped;
 *   • the offset path orders by `created_at DESC, id DESC`, so datasets with
 *     duplicate `created_at` sort values still paginate without gaps or
 *     duplicates;
 *   • concurrent inserts during a traversal never duplicate or drop a
 *     pre-existing row.
 *
 * All PG pool interactions are mocked — no live database is required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';

// ── Mock pool query implementation ───────────────────────────────────────────
let currentDataset: Record<string, any>[] = [];

interface OrderKey {
  column: string;
  direction: 'ASC' | 'DESC';
}

/** Compare two column values the way PostgreSQL orders them (text + timestamptz). */
function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return ta === tb ? 0 : ta < tb ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Parse the ORDER BY clause emitted by StreamQueryBuilder (single or composite key). */
function parseOrderKeys(sql: string): OrderKey[] {
  const match = sql.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+OFFSET|$)/i);
  if (!match || !match[1]) return [{ column: 'id', direction: 'ASC' }];
  return match[1].split(',').map((clause) => {
    const [column, direction] = clause.trim().split(/\s+/);
    return {
      column: column!,
      direction: (direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC') as 'ASC' | 'DESC',
    };
  });
}

/**
 * Minimal in-memory stand-in for PostgreSQL.
 *
 * It honours the parts of the generated SQL that the pagination guarantee
 * depends on: WHERE predicates, multi-column ORDER BY with direction, and
 * parameterised LIMIT/OFFSET.  Keeping the mock faithful means the property
 * tests exercise the real cursor/offset ordering contracts rather than a
 * simplified "sort by id" shortcut.
 */
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

  // Apply the emitted ORDER BY (id ASC for keyset, created_at DESC, id DESC for offset).
  const orderKeys = parseOrderKeys(sql);
  filtered.sort((a, b) => {
    for (const { column, direction } of orderKeys) {
      const cmp = compareValues(a[column], b[column]);
      if (cmp !== 0) return direction === 'DESC' ? -cmp : cmp;
    }
    return 0;
  });

  // OFFSET $N (offset pagination only).
  const offsetMatch = sql.match(/OFFSET\s+\$(\d+)/i);
  if (offsetMatch && offsetMatch[1]) {
    filtered = filtered.slice(Number(queryParams[parseInt(offsetMatch[1], 10) - 1]));
  }

  // LIMIT $N (the cursor path asks for limit + 1 rows to detect `hasMore`).
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

vi.mock('../src/db/queries/streams.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/queries/streams.js')>();
  return {
    ...actual,
    encryptAddressValue: vi.fn((col: number) => `$${col}`),
    streamSelectColumns: vi.fn(() => '*'),
    senderAddressFilterCondition: vi.fn((f: number) => `sender_address = $${f}`),
    recipientAddressFilterCondition: vi.fn((f: number) => `recipient_address = $${f}`),
  };
});

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

/** Build a complete stream row fixture used by the ordering-guarantee tests. */
function makeStreamRow(id: string, createdAt: Date) {
  return {
    id,
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
    transaction_hash: 'a'.repeat(64),
    event_index: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

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

  // ── Ordering-guarantee contracts ────────────────────────────────────────────

  it('orders cursor pages by `id` ASC with an exclusive afterId bound', async () => {
    const shared = new Date('2026-06-26T12:00:00.000Z');
    currentDataset = [
      makeStreamRow('stream-b', shared),
      makeStreamRow('stream-a', shared),
      makeStreamRow('stream-c', shared),
    ];

    const firstPage = await streamRepository.findWithCursor({}, 2);
    expect(firstPage.streams.map((s) => s.id)).toEqual(['stream-a', 'stream-b']);

    await streamRepository.findWithCursor({}, 2, 'stream-b');

    const dataCalls = mockQuery.mock.calls.filter(
      ([, sql]) => !String(sql).includes('COUNT(*)'),
    );
    const firstSql = String(dataCalls[0]![1]);
    const nextSql = String(dataCalls[1]![1]);

    // The ordering key is `id` — the streams primary key (TEXT NOT NULL,
    // unique) — so the order is total and page windows cannot overlap or gap.
    expect(firstSql).toMatch(/ORDER BY\s+id\s+ASC/i);
    // afterId is an exclusive lower bound: the previous page's last row is
    // never re-emitted, and a unique key means nothing is skipped either.
    expect(nextSql).toMatch(/\bid\s*>\s*\$\d+/);
    expect(nextSql).not.toMatch(/\bid\s*>=\s*\$\d+/);
  });

  it('never repeats or skips duplicate sort values across offset pages', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(streamRecordArb, { minLength: 0, maxLength: 80 }),
        fc.integer({ min: 1, max: 20 }),
        async (rawStreams, pageSize) => {
          const shared = new Date('2026-06-26T12:00:00.000Z');
          // Force a large share of duplicate `created_at` ordering values.
          const streams = rawStreams.map((s, idx) => ({
            ...s,
            id: `offset-${idx}-${s.id.slice(7)}`,
            created_at: idx % 3 === 0 ? shared : s.created_at,
            updated_at: idx % 3 === 0 ? shared : s.created_at,
          }));
          currentDataset = streams;

          // Expected total order: created_at DESC, then the id tiebreaker DESC.
          const expectedIds = [...streams]
            .sort((a, b) => {
              const byDate = b.created_at.getTime() - a.created_at.getTime();
              if (byDate !== 0) return byDate;
              return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
            })
            .map((s) => s.id);

          const collected: string[] = [];
          let offset = 0;
          for (let guard = 0; guard < streams.length + 5; guard++) {
            const page = await streamRepository.find({}, { limit: pageSize, offset });
            collected.push(...page.streams.map((s) => s.id));
            if (!page.hasMore) break;
            expect(page.streams.length).toBeGreaterThan(0);
            offset += page.streams.length;
          }

          // Every row once, in the documented order — no repeats, no omissions.
          expect(collected).toEqual(expectedIds);
          expect(new Set(collected).size).toBe(collected.length);
        },
      ),
      { seed: 4242, numRuns: 50 },
    );
  });

  it('returns every pre-existing row exactly once when rows are inserted mid-traversal', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(streamRecordArb, { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1, max: 15 }),
        fc.array(streamRecordArb, { minLength: 1, maxLength: 20 }),
        async (rawExisting, limit, rawInserted) => {
          // Half the table shares one `created_at`, so the traversal runs over
          // rows with duplicate non-unique sort values as well.
          const shared = new Date('2026-06-26T12:00:00.000Z');
          const existing = rawExisting.map((s, idx) => ({
            ...s,
            id: `existing-${idx}-${s.id.slice(7)}`,
            created_at: idx % 2 === 0 ? shared : s.created_at,
            updated_at: idx % 2 === 0 ? shared : s.created_at,
          }));
          const inserted = rawInserted.map((s, idx) => ({
            ...s,
            id: `inserted-${idx}-${s.id.slice(7)}`,
            created_at: idx % 2 === 0 ? shared : s.created_at,
            updated_at: idx % 2 === 0 ? shared : s.created_at,
          }));
          currentDataset = [...existing];

          const existingIds = new Set(existing.map((s) => s.id));
          const fetched: string[] = [];
          let afterId: string | undefined;
          let insertedOnce = false;

          for (let guard = 0; guard < existing.length + inserted.length + 5; guard++) {
            const page = await streamRepository.findWithCursor({}, limit, afterId);
            fetched.push(...page.streams.map((s) => s.id));

            // A concurrent writer commits new rows once the first page is in flight.
            if (!insertedOnce && page.streams.length > 0) {
              currentDataset = [...currentDataset, ...inserted];
              insertedOnce = true;
            }

            if (!page.hasMore) break;
            expect(page.streams.length).toBeGreaterThan(0);
            afterId = page.streams[page.streams.length - 1]!.id;
          }

          // No duplicates anywhere in the traversal...
          expect(new Set(fetched).size).toBe(fetched.length);
          // ...and every row that existed at the start is returned exactly once.
          for (const id of existingIds) {
            expect(fetched.filter((fetchedId) => fetchedId === id)).toHaveLength(1);
          }
          // Ordering stays strictly ascending on the unique ordering key.
          for (let i = 1; i < fetched.length; i++) {
            expect(fetched[i - 1]! < fetched[i]!).toBe(true);
          }
        },
      ),
      { seed: 1337, numRuns: 50 },
    );
  });
});
