/**
 * Unit tests for dlqRepository (PostgreSQL-backed).
 *
 * Covers:
 *  - insert serialization of normal payloads, circular references, BigInt,
 *    and other non-serializable values (Issue #519: non-serializable payloads
 *    must be caught and a safe fallback recorded rather than letting insert throw).
 *  - failure history: the enqueue seeds the first cause, and `recordFailure`
 *    appends every later attempt's cause without ever replacing a recorded one.
 *  - consumer suspension lookups and bookkeeping (getConsumerSuspension,
 *    listSuspendedConsumers, recordReplayFailure, recordReplaySuccess,
 *    resumeConsumer).
 *
 * All pg pool interactions are mocked — no real database required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({})),
  initializeConfig: vi.fn(),
}));

import { dlqRepository } from '../../src/db/repositories/dlqRepository.js';
import type { DlqEntry, DlqFailureAttempt } from '../../src/routes/dlq.js';

/** `$n` placeholder of a column inside an INSERT column list, e.g. `payload` → 4. */
function paramIndexOfColumn(sql: string, column: string): number {
  const match = /\(([^)]*)\)\s*VALUES/.exec(sql);
  if (!match) throw new Error(`no column list in SQL: ${sql}`);
  const columns = (match[1] ?? '').split(',').map((c) => c.trim());
  const position = columns.indexOf(column);
  if (position === -1) throw new Error(`column '${column}' not in ${columns.join(', ')}`);
  return position;
}

function makeDlqEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: 'dlq-001',
    topic: 'stream.created',
    payload: { data: 'test' },
    error: 'Network timeout',
    attempts: 1,
    correlationId: 'corr-123',
    firstFailedAt: '2026-01-01T00:00:00.000Z',
    lastFailedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A `dead_letter_queue` row as node-postgres returns it. */
function makeEntryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'dlq-001',
    tenant_id: null,
    topic: 'stream.created',
    payload: { data: 'test' },
    error: 'Network timeout',
    attempts: 1,
    correlation_id: 'corr-123',
    first_failed_at: new Date('2026-01-01T00:00:00Z'),
    last_failed_at: new Date('2026-01-01T00:00:00Z'),
    status: 'dead',
    failure_history: [{ error: 'Network timeout', attempt: 1, failedAt: '2026-01-01T00:00:00.000Z', source: 'enqueue' }],
    ...overrides,
  };
}

function makeSuspensionRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    topic: 'stream.created',
    consecutive_failures: 2,
    suspended: false,
    suspended_at: null,
    resumed_at: null,
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('dlqRepository.insert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rowCount: 1 });
  });

  it('inserts a normal payload via JSON.stringify', async () => {
    const entry = makeDlqEntry({
      payload: { streamId: 'abc-123', amount: '1000' },
    });

    await dlqRepository.insert(entry);

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[paramIndexOfColumn(sql, 'payload')];
    expect(typeof serializedPayload).toBe('string');
    expect(JSON.parse(serializedPayload as string)).toEqual({
      streamId: 'abc-123',
      amount: '1000',
    });
  });

  it('handles circular reference without throwing', async () => {
    const circular: any = { data: 'value' };
    circular.self = circular; // Circular reference

    const entry = makeDlqEntry({ payload: circular });

    // Should not throw; instead records safe fallback
    await dlqRepository.insert(entry);

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[paramIndexOfColumn(sql, 'payload')] as string;
    const fallback = JSON.parse(serializedPayload);

    expect(fallback._serialization_error).toBe(true);
    expect(fallback.reason).toContain('circular');
    expect(fallback.type).toBe('object');
    expect(fallback.timestamp).toBeDefined();
  });

  it('handles BigInt without throwing', async () => {
    const entry = makeDlqEntry({
      payload: { amount: BigInt('9007199254740992') },
    });

    // Should not throw; instead records safe fallback
    await dlqRepository.insert(entry);

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[paramIndexOfColumn(sql, 'payload')] as string;
    const fallback = JSON.parse(serializedPayload);

    expect(fallback._serialization_error).toBe(true);
    expect(fallback.reason).toContain('BigInt');
    expect(fallback.type).toBe('object');
  });

  it('handles nested non-serializable values', async () => {
    const entry = makeDlqEntry({
      payload: {
        nested: {
          // BigInt makes JSON.stringify throw at any depth.
          value: BigInt('9007199254740993'),
        },
      },
    });

    // Should not throw; instead records safe fallback
    await dlqRepository.insert(entry);

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[paramIndexOfColumn(sql, 'payload')] as string;
    const fallback = JSON.parse(serializedPayload);

    expect(fallback._serialization_error).toBe(true);
    expect(fallback.type).toBe('object');
  });

  it('records a symbol-valued payload without throwing', async () => {
    // JSON.stringify drops symbol-valued properties instead of throwing, so
    // the insert must still succeed — the payload is recorded as its
    // serializable remainder, with no serialization failure to report.
    const entry = makeDlqEntry({ payload: { nested: { value: Symbol('test-symbol') } } });

    await expect(dlqRepository.insert(entry)).resolves.toBeUndefined();

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[paramIndexOfColumn(sql, 'payload')] as string;
    expect(JSON.parse(serializedPayload)).toEqual({ nested: {} });
  });

  it('successfully records DLQ row even when payload serialization falls back', async () => {
    const circular: any = { data: 'value' };
    circular.self = circular;

    const entry = makeDlqEntry({
      id: 'dlq-circular-001',
      topic: 'bad.stream',
      payload: circular,
    });

    await dlqRepository.insert(entry);

    // Verify INSERT was called (not thrown)
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO dead_letter_queue');
  });

  it('does not include original payload in fallback representation (security)', async () => {
    const secretData = { apiKey: 'secret-key-12345', data: 'public' };
    // Make it circular to trigger serialization failure
    const payload: any = secretData;
    payload.self = payload;

    const entry = makeDlqEntry({ payload });

    await dlqRepository.insert(entry);

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[paramIndexOfColumn(sql, 'payload')] as string;

    // Fallback should not contain the secret
    expect(serializedPayload).not.toContain('secret-key-12345');
    expect(serializedPayload).not.toContain('apiKey');
  });

  it('records payload type in fallback for debugging', async () => {
    const circular: any = { data: 'test' };
    circular.ref = circular;

    const entry = makeDlqEntry({
      payload: circular,
    });

    await dlqRepository.insert(entry);

    const [, sql, params] = mockQuery.mock.calls[0]!;
    const fallback = JSON.parse(params[paramIndexOfColumn(sql, 'payload')] as string);

    expect(fallback.type).toBe('object');
    expect(fallback.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('dlqRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getConsumerSuspension', () => {
    it('queries by topic and maps row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeSuspensionRow()] });
      const record = await dlqRepository.getConsumerSuspension('stream.created');

      expect(record).toBeDefined();
      expect(record!.topic).toBe('stream.created');
      expect(record!.consecutiveFailures).toBe(2);
      expect(record!.suspended).toBe(false);

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('SELECT * FROM dlq_consumer_suspension WHERE topic = $1');
      expect(params).toEqual(['stream.created']);
    });

    it('returns null when no record is found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const record = await dlqRepository.getConsumerSuspension('missing');
      expect(record).toBeNull();
    });
  });

  describe('listSuspendedConsumers', () => {
    it('queries and returns all mapped records ordered by topic', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeSuspensionRow({
            topic: 'stream.cancelled',
            consecutive_failures: 5,
            suspended: true,
          }),
          makeSuspensionRow({ topic: 'stream.created' }),
        ],
      });
      const list = await dlqRepository.listSuspendedConsumers();

      expect(list).toHaveLength(2);
      expect(list[0]!.topic).toBe('stream.cancelled');
      expect(list[0]!.suspended).toBe(true);
      expect(list[1]!.topic).toBe('stream.created');

      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('SELECT * FROM dlq_consumer_suspension ORDER BY topic');
    });
  });

  describe('recordReplayFailure', () => {
    it('uses GREATEST to clamp consecutive_failures at 0 and increments correctly', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeSuspensionRow({ consecutive_failures: 3 })],
      });
      const result = await dlqRepository.recordReplayFailure('stream.created');

      expect(result.consecutiveFailures).toBe(3);

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO dlq_consumer_suspension');
      expect(sql).toContain('ON CONFLICT (topic) DO UPDATE');
      // Verify GREATEST is used on update to clamp count to non-negative values
      expect(sql).toContain('GREATEST(0, dlq_consumer_suspension.consecutive_failures) + 1');
      expect(params).toEqual(['stream.created', 5]); // default threshold 5
    });
  });

  describe('recordReplaySuccess', () => {
    it('resets consecutive_failures and suspended flag to false', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await dlqRepository.recordReplaySuccess('stream.created');

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO dlq_consumer_suspension');
      expect(sql).toContain('SET consecutive_failures = 0');
      expect(params).toEqual(['stream.created']);
    });
  });

  describe('resumeConsumer', () => {
    it('resets consecutive_failures to 0 and suspended flag to false', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeSuspensionRow({ consecutive_failures: 0, suspended: false, resumed_at: new Date() }),
        ],
      });
      const record = await dlqRepository.resumeConsumer('stream.created');

      expect(record).toBeDefined();
      expect(record!.consecutiveFailures).toBe(0);
      expect(record!.suspended).toBe(false);

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE dlq_consumer_suspension');
      expect(sql).toContain('SET suspended = FALSE');
      expect(sql).toContain('consecutive_failures = 0');
      expect(params).toEqual(['stream.created']);
    });

    it('returns null when database updates no rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const record = await dlqRepository.resumeConsumer('missing');
      expect(record).toBeNull();
    });
  });
});

// ── Failure history ───────────────────────────────────────────────────────────

describe('dlqRepository failure history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('insert', () => {
    beforeEach(() => {
      mockQuery.mockResolvedValue({ rowCount: 1 });
    });

    it('seeds the history with the first failure cause', async () => {
      await dlqRepository.insert(makeDlqEntry({ error: 'RPC timeout', attempts: 2 }));

      const [, sql, params] = mockQuery.mock.calls[0]!;
      const history = JSON.parse(params[paramIndexOfColumn(sql, 'failure_history')] as string);

      expect(history).toEqual([
        {
          error: 'RPC timeout',
          attempt: 2,
          failedAt: '2026-01-01T00:00:00.000Z',
          source: 'enqueue',
        },
      ]);
    });

    it('preserves a caller-supplied history verbatim', async () => {
      const failureHistory: DlqFailureAttempt[] = [
        { error: 'first', attempt: 1, failedAt: '2026-01-01T00:00:00.000Z', source: 'enqueue' },
        { error: 'second', attempt: 2, failedAt: '2026-01-02T00:00:00.000Z', source: 'replay' },
      ];

      await dlqRepository.insert(makeDlqEntry({ error: 'first', failureHistory }));

      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(JSON.parse(params[paramIndexOfColumn(sql, 'failure_history')] as string)).toEqual(failureHistory);
    });
  });

  describe('recordFailure', () => {
    it('appends to the history instead of replacing it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeEntryRow()] });

      await dlqRepository.recordFailure('dlq-001', {
        error: 'ECONNRESET on replay',
        source: 'replay',
        failedAt: '2026-01-02T00:00:00.000Z',
      });

      const [, sql, params] = mockQuery.mock.calls[0]!;
      // `||` concatenation is what makes the write append-only.
      expect(sql).toContain("COALESCE(failure_history, '[]'::jsonb) || jsonb_build_array(");
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual(['dlq-001', '2026-01-02T00:00:00.000Z', 'ECONNRESET on replay', 'replay']);
    });

    it('never rewrites the first cause', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeEntryRow()] });

      await dlqRepository.recordFailure('dlq-001', {
        error: 'later failure',
        source: 'replay',
        failedAt: '2026-01-02T00:00:00.000Z',
      });

      const [, sql] = mockQuery.mock.calls[0]!;
      const setClause = /SET([\s\S]*?)WHERE id/i.exec(sql)?.[1] ?? '';
      expect(setClause).not.toMatch(/(^|[\s,])error\s*=/);
    });

    it('records the attempt counter and last-failure timestamp in the same statement', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeEntryRow()] });

      await dlqRepository.recordFailure('dlq-001', {
        error: 'boom',
        source: 'replay',
        failedAt: '2026-01-02T00:00:00.000Z',
      });

      const [, sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('attempts         = GREATEST(0, attempts) + 1');
      expect(sql).toContain('last_failed_at   = $2::timestamptz');
      // The stored ordinal is derived from the row, and the recorded timestamp
      // is the reported one — kept verbatim so the audit trail reads as sent.
      expect(sql).toContain("'attempt',  GREATEST(0, attempts) + 1");
      expect(sql).toContain("'failedAt', to_jsonb($2::text)");
    });

    it('returns undefined when the entry no longer exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(
        dlqRepository.recordFailure('gone', { error: 'x', source: 'replay', failedAt: '2026-01-02T00:00:00.000Z' }),
      ).resolves.toBeUndefined();
    });

    it('maps the stored history back onto the entry', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeEntryRow({
            error: 'first cause',
            attempts: 3,
            failure_history: [
              { error: 'first cause', attempt: 1, failedAt: '2026-01-01T00:00:00.000Z', source: 'enqueue' },
              { error: 'second cause', attempt: 3, failedAt: '2026-01-03T00:00:00.000Z', source: 'replay' },
            ],
          }),
        ],
      });

      const entry = await dlqRepository.recordFailure('dlq-001', {
        error: 'second cause',
        source: 'replay',
        failedAt: '2026-01-03T00:00:00.000Z',
      });

      expect(entry!.error).toBe('first cause');
      expect(entry!.failureHistory).toEqual([
        { error: 'first cause', attempt: 1, failedAt: '2026-01-01T00:00:00.000Z', source: 'enqueue' },
        { error: 'second cause', attempt: 3, failedAt: '2026-01-03T00:00:00.000Z', source: 'replay' },
      ]);
    });
  });

  /**
   * A contract fake for the one statement `recordFailure` issues. It applies
   * only the semantics that statement relies on — append to `failure_history`,
   * increment `attempts`, refresh `last_failed_at`, leave `error` alone — so a
   * sequence of failures can be observed end to end without a database.
   */
  function fakeDeadLetterQueue(seed: Record<string, unknown>) {
    const row: Record<string, unknown> = { ...seed };
    mockQuery.mockImplementation(async (_pool: unknown, sql: string, params: unknown[]) => {
      if (!/UPDATE dead_letter_queue/.test(sql)) {
        throw new Error(`unexpected statement: ${sql}`);
      }
      const [id, failedAt, error, source] = params as [string, string, string, string];
      if (id !== row['id']) return { rows: [], rowCount: 0 };

      const history = Array.isArray(row['failure_history']) ? [...(row['failure_history'] as unknown[])] : [];
      const nextAttempt = Math.max(0, Number(row['attempts'])) + 1;
      history.push({ error, attempt: nextAttempt, failedAt, source });

      row['attempts'] = nextAttempt;
      row['last_failed_at'] = new Date(failedAt);
      row['failure_history'] = history;
      return { rows: [{ ...row }], rowCount: 1 };
    });
    return row;
  }

  it('retains every cause when an item is failed repeatedly with different errors', async () => {
    const row = fakeDeadLetterQueue(
      makeEntryRow({
        error: 'connection refused',
        attempts: 1,
        failure_history: [
          { error: 'connection refused', attempt: 1, failedAt: '2026-01-01T00:00:00.000Z', source: 'enqueue' },
        ],
      }),
    );

    const causes = ['connection refused', 'TLS handshake timeout', 'upstream 503', 'signature mismatch'];
    let entry: DlqEntry | undefined;
    for (const cause of causes.slice(1)) {
      entry = await dlqRepository.recordFailure('dlq-001', {
        error: cause,
        source: 'replay',
        failedAt: `2026-01-0${causes.indexOf(cause) + 1}T00:00:00.000Z`,
      });
    }

    // Every cause survives, oldest first.
    expect(entry!.failureHistory!.map((f) => f.error)).toEqual(causes);
    // The first cause is still the entry's own error.
    expect(entry!.error).toBe('connection refused');
    expect(row['error']).toBe('connection refused');
    // Each attempt recorded its ordinal and a timestamp.
    expect(entry!.failureHistory!.map((f) => f.attempt)).toEqual([1, 2, 3, 4]);
    for (const failure of entry!.failureHistory!) {
      expect(failure.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(entry!.attempts).toBe(4);
  });

  describe('rowToFailureHistory fallbacks', () => {
    it('derives the first cause for a row with no stored history', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeEntryRow({ failure_history: [], error: 'legacy cause', attempts: 2 })],
      });

      const entry = await dlqRepository.findById('dlq-001');

      expect(entry!.failureHistory).toEqual([
        { error: 'legacy cause', attempt: 2, failedAt: '2026-01-01T00:00:00.000Z', source: 'legacy-row' },
      ]);
    });

    it('parses a history column delivered as a JSON string', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeEntryRow({
            failure_history: JSON.stringify([
              { error: 'stringified', attempt: 1, failedAt: '2026-01-01T00:00:00.000Z', source: 'enqueue' },
            ]),
          }),
        ],
      });

      const entry = await dlqRepository.findById('dlq-001');

      expect(entry!.failureHistory).toHaveLength(1);
      expect(entry!.failureHistory![0]!.error).toBe('stringified');
    });

    it('drops history records that carry no cause', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeEntryRow({
            error: 'usable cause',
            failure_history: [
              { attempt: 1, failedAt: '2026-01-01T00:00:00.000Z' },
              { error: '', attempt: 2, failedAt: '2026-01-02T00:00:00.000Z' },
              { error: 'usable cause', attempt: 3, failedAt: '2026-01-03T00:00:00.000Z', source: 'replay' },
            ],
          }),
        ],
      });

      const entry = await dlqRepository.findById('dlq-001');

      expect(entry!.failureHistory!.map((f) => f.error)).toEqual(['usable cause']);
    });

    it('returns an empty history when a row has no cause at all', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeEntryRow({ error: '', failure_history: [] })],
      });

      const entry = await dlqRepository.findById('dlq-001');

      expect(entry!.failureHistory).toEqual([]);
    });
  });
});
