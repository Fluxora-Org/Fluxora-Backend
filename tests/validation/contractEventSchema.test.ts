/**
 * Unit tests for ContractEventSchema and ContractEventBatchSchema.
 *
 * Covers:
 * - Valid event acceptance
 * - topic enum enforcement (all known values + unknown rejection)
 * - Required field enforcement
 * - Extra/unknown field rejection (strictObject)
 * - Field type validation (ledger, txIndex, operationIndex, eventIndex as integers)
 * - payload must be a non-null object
 * - Intra-batch duplicate eventId detection
 * - Empty batch rejection
 * - Batch size limit (max 100)
 */

import { describe, it, expect } from 'vitest';
import {
  ContractEventSchema,
  ContractEventBatchSchema,
  CONTRACT_EVENT_TOPICS,
} from '../../src/validation/schemas.js';

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-001',
    ledger: 512345,
    contractId: 'CBIELTK6YBZJU5UP2WWQEQPMCSB5TTNBMMKVDPKA2QCMXGFQKQKJ4AB',
    topic: 'stream.created' as const,
    txHash: 'a3f4b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3',
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { streamId: 'stream-abc123', depositAmount: '1000000.0000000' },
    happenedAt: '2026-01-01T00:00:00.000Z',
    ledgerHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    ...overrides,
  };
}

describe('CONTRACT_EVENT_TOPICS', () => {
  it('exports exactly 6 known topics', () => {
    expect(CONTRACT_EVENT_TOPICS).toHaveLength(6);
  });

  it('contains all expected topic values', () => {
    expect(CONTRACT_EVENT_TOPICS).toContain('stream.created');
    expect(CONTRACT_EVENT_TOPICS).toContain('stream.updated');
    expect(CONTRACT_EVENT_TOPICS).toContain('stream.cancelled');
    expect(CONTRACT_EVENT_TOPICS).toContain('stream.completed');
    expect(CONTRACT_EVENT_TOPICS).toContain('stream.funded');
    expect(CONTRACT_EVENT_TOPICS).toContain('stream.withdrawn');
  });
});

describe('ContractEventSchema', () => {
  // ── valid inputs ───────────────────────────────────────────────────────────

  it('accepts a fully valid event', () => {
    const result = ContractEventSchema.safeParse(validEvent());
    expect(result.success).toBe(true);
  });

  it.each(CONTRACT_EVENT_TOPICS)('accepts topic "%s"', (topic) => {
    const result = ContractEventSchema.safeParse(validEvent({ topic }));
    expect(result.success).toBe(true);
  });

  it('preserves all fields on successful parse', () => {
    const input = validEvent();
    const result = ContractEventSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventId).toBe('evt-001');
      expect(result.data.ledger).toBe(512345);
      expect(result.data.topic).toBe('stream.created');
      expect(result.data.payload).toEqual({ streamId: 'stream-abc123', depositAmount: '1000000.0000000' });
    }
  });

  // ── topic enum ─────────────────────────────────────────────────────────────

  it('rejects an unknown topic value', () => {
    const result = ContractEventSchema.safeParse(validEvent({ topic: 'stream.unknown' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty topic string', () => {
    const result = ContractEventSchema.safeParse(validEvent({ topic: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects topic with wrong casing', () => {
    const result = ContractEventSchema.safeParse(validEvent({ topic: 'Stream.Created' }));
    expect(result.success).toBe(false);
  });

  // ── required fields ────────────────────────────────────────────────────────

  it.each(['eventId', 'ledger', 'contractId', 'topic', 'txHash', 'txIndex', 'operationIndex', 'eventIndex', 'payload', 'happenedAt', 'ledgerHash'])(
    'rejects when required field "%s" is missing',
    (field) => {
      const input = validEvent();
      delete (input as Record<string, unknown>)[field];
      const result = ContractEventSchema.safeParse(input);
      expect(result.success).toBe(false);
    },
  );

  // ── type validation ────────────────────────────────────────────────────────

  it('rejects non-integer ledger', () => {
    const result = ContractEventSchema.safeParse(validEvent({ ledger: 1.5 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative ledger', () => {
    const result = ContractEventSchema.safeParse(validEvent({ ledger: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative eventIndex', () => {
    const result = ContractEventSchema.safeParse(validEvent({ eventIndex: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative txIndex', () => {
    const result = ContractEventSchema.safeParse(validEvent({ txIndex: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative operationIndex', () => {
    const result = ContractEventSchema.safeParse(validEvent({ operationIndex: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects empty eventId string', () => {
    const result = ContractEventSchema.safeParse(validEvent({ eventId: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty txHash string', () => {
    const result = ContractEventSchema.safeParse(validEvent({ txHash: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty contractId string', () => {
    const result = ContractEventSchema.safeParse(validEvent({ contractId: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty happenedAt string', () => {
    const result = ContractEventSchema.safeParse(validEvent({ happenedAt: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty ledgerHash string', () => {
    const result = ContractEventSchema.safeParse(validEvent({ ledgerHash: '' }));
    expect(result.success).toBe(false);
  });

  // ── payload validation ─────────────────────────────────────────────────────

  it('accepts an empty payload object', () => {
    const result = ContractEventSchema.safeParse(validEvent({ payload: {} }));
    expect(result.success).toBe(true);
  });

  it('rejects a string payload', () => {
    const result = ContractEventSchema.safeParse(validEvent({ payload: 'not-an-object' }));
    expect(result.success).toBe(false);
  });

  it('rejects a numeric payload', () => {
    const result = ContractEventSchema.safeParse(validEvent({ payload: 42 }));
    expect(result.success).toBe(false);
  });

  it('rejects an array payload', () => {
    const result = ContractEventSchema.safeParse(validEvent({ payload: ['a', 'b'] }));
    expect(result.success).toBe(false);
  });

  it('rejects a null payload', () => {
    const result = ContractEventSchema.safeParse(validEvent({ payload: null }));
    expect(result.success).toBe(false);
  });

  // ── extra field rejection (strictObject) ──────────────────────────────────

  it('rejects unknown top-level fields', () => {
    const result = ContractEventSchema.safeParse(validEvent({ unknownField: 'injected' }));
    expect(result.success).toBe(false);
  });

  it('rejects multiple unknown fields', () => {
    const result = ContractEventSchema.safeParse(validEvent({ foo: 1, bar: 2 }));
    expect(result.success).toBe(false);
  });

  it('error message mentions the unrecognized key on extra field', () => {
    const result = ContractEventSchema.safeParse(validEvent({ forgedField: 'evil' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages.toLowerCase()).toMatch(/unrecognized|forgedfield/i);
    }
  });
});

describe('ContractEventBatchSchema', () => {
  // ── valid batches ──────────────────────────────────────────────────────────

  it('accepts a single-event batch', () => {
    const result = ContractEventBatchSchema.safeParse({ events: [validEvent()] });
    expect(result.success).toBe(true);
  });

  it('accepts a multi-event batch with unique eventIds', () => {
    const result = ContractEventBatchSchema.safeParse({
      events: [
        validEvent({ eventId: 'e1' }),
        validEvent({ eventId: 'e2' }),
        validEvent({ eventId: 'e3' }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a batch with all 6 different topic types', () => {
    const events = CONTRACT_EVENT_TOPICS.map((topic, i) =>
      validEvent({ eventId: `e${i}`, topic }),
    );
    const result = ContractEventBatchSchema.safeParse({ events });
    expect(result.success).toBe(true);
  });

  // ── empty batch ────────────────────────────────────────────────────────────

  it('rejects an empty events array', () => {
    const result = ContractEventBatchSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  // ── batch size limit ───────────────────────────────────────────────────────

  it('accepts exactly 100 events', () => {
    const events = Array.from({ length: 100 }, (_, i) => validEvent({ eventId: `e${i}` }));
    const result = ContractEventBatchSchema.safeParse({ events });
    expect(result.success).toBe(true);
  });

  it('rejects 101 events', () => {
    const events = Array.from({ length: 101 }, (_, i) => validEvent({ eventId: `e${i}` }));
    const result = ContractEventBatchSchema.safeParse({ events });
    expect(result.success).toBe(false);
  });

  // ── intra-batch duplicate eventId ─────────────────────────────────────────

  it('rejects a batch with duplicate eventIds', () => {
    const result = ContractEventBatchSchema.safeParse({
      events: [validEvent({ eventId: 'dup' }), validEvent({ eventId: 'dup' })],
    });
    expect(result.success).toBe(false);
  });

  it('duplicate error message identifies the offending eventId', () => {
    const result = ContractEventBatchSchema.safeParse({
      events: [validEvent({ eventId: 'dup-id' }), validEvent({ eventId: 'dup-id' })],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/dup-id/);
    }
  });

  it('accepts a batch where one event has an unknown topic — reports field error', () => {
    const result = ContractEventBatchSchema.safeParse({
      events: [validEvent({ eventId: 'e1', topic: 'stream.forged' })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a batch where one event has an extra unknown field', () => {
    const result = ContractEventBatchSchema.safeParse({
      events: [validEvent({ eventId: 'e1', injected: 'payload' })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects when events field is missing', () => {
    const result = ContractEventBatchSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects when events is not an array', () => {
    const result = ContractEventBatchSchema.safeParse({ events: 'not-an-array' });
    expect(result.success).toBe(false);
  });
});
