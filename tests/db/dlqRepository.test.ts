/**
 * Unit tests for dlqRepository (PostgreSQL-backed).
 *
 * Covers:
 *  - insert serialization of normal payloads, circular references, BigInt,
 *    and other non-serializable values (Issue #519: non-serializable payloads
 *    must be caught and a safe fallback recorded rather than letting insert throw).
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
import type { DlqEntry } from '../../src/routes/dlq.js';

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

    const [, , params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[2];
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

    const [, , params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[2] as string;
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

    const [, , params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[2] as string;
    const fallback = JSON.parse(serializedPayload);

    expect(fallback._serialization_error).toBe(true);
    expect(fallback.reason).toContain('BigInt');
    expect(fallback.type).toBe('object');
  });

  it('handles nested non-serializable values', async () => {
    const entry = makeDlqEntry({
      payload: {
        nested: {
          value: Symbol('test-symbol'),
        },
      },
    });

    // Should not throw
    await dlqRepository.insert(entry);

    const [, , params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[2] as string;
    const fallback = JSON.parse(serializedPayload);

    expect(fallback._serialization_error).toBe(true);
    expect(fallback.type).toBe('object');
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

    const [, , params] = mockQuery.mock.calls[0]!;
    const serializedPayload = params[2] as string;

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

    const [, , params] = mockQuery.mock.calls[0]!;
    const fallback = JSON.parse(params[2] as string);

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
