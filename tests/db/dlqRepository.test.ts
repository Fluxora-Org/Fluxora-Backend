/**
 * Unit tests for dlqRepository.insert (PostgreSQL-backed).
 *
 * Covers: serialization of normal payloads, circular references, BigInt,
 * and other non-serializable values. All pg pool interactions are mocked —
 * no real database required.
 *
 * Issue #519: Verify that non-serializable payloads are caught and a safe
 * fallback representation is recorded, not letting the insert throw.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
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
