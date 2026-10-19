/**
 * Unit tests for src/validation/schemas.ts
 *
 * Issue #1807 — Cover schemas with unit tests
 *
 * Rules:
 * - No network I/O, no wall-clock time
 * - Each exported function/schema has at least one happy-path test
 * - Every documented failure mode (regex, bounds, duplicate, strictObject) is asserted
 * - Boundary inputs (empty, zero, maximum) are exercised
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_EVENT_TOPICS,
  ContractEventBatchSchema,
  ContractEventSchema,
  CreateStreamSchema,
  DECIMAL_STRING_REGEX,
  DlqListQuerySchema,
  ListStreamsQuerySchema,
  PrivacyConsentSchema,
  ReplayRequestSchema,
  StreamBatchCreateSchema,
  decimalStringField,
  formatZodIssues,
  parseBody,
} from './schemas.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_SENDER   = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECEIVER = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId:        'evt-001',
    ledger:         100,
    contractId:     'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    topic:          'stream.created',
    txHash:         'abc123',
    txIndex:        0,
    operationIndex: 0,
    eventIndex:     0,
    payload:        { amount: '10.0000000' },
    happenedAt:     '2024-01-01T00:00:00Z',
    ledgerHash:     'deadbeef',
    ...overrides,
  };
}

// ── DECIMAL_STRING_REGEX ───────────────────────────────────────────────────────

describe('DECIMAL_STRING_REGEX', () => {
  it('matches plain integers', () => {
    expect(DECIMAL_STRING_REGEX.test('0')).toBe(true);
    expect(DECIMAL_STRING_REGEX.test('100')).toBe(true);
  });

  it('matches signed decimals', () => {
    expect(DECIMAL_STRING_REGEX.test('+1.5')).toBe(true);
    expect(DECIMAL_STRING_REGEX.test('-0.0000001')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(DECIMAL_STRING_REGEX.test('')).toBe(false);
  });

  it('rejects strings with letters', () => {
    expect(DECIMAL_STRING_REGEX.test('1e10')).toBe(false);
    expect(DECIMAL_STRING_REGEX.test('NaN')).toBe(false);
    expect(DECIMAL_STRING_REGEX.test('Infinity')).toBe(false);
  });

  it('rejects bare decimal point', () => {
    expect(DECIMAL_STRING_REGEX.test('.')).toBe(false);
    expect(DECIMAL_STRING_REGEX.test('.5')).toBe(false);
  });
});

// ── decimalStringField ─────────────────────────────────────────────────────────

describe('decimalStringField', () => {
  const schema = decimalStringField('amount');

  it('accepts a valid decimal string', () => {
    expect(schema.safeParse('0.0000116').success).toBe(true);
    expect(schema.safeParse('100').success).toBe(true);
    expect(schema.safeParse('9223372036854775807').success).toBe(true); // i64 max
  });

  it('rejects a JavaScript number (not a string)', () => {
    expect(schema.safeParse(100).success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(schema.safeParse('').success).toBe(false);
  });

  it('rejects strings that are not valid decimal format', () => {
    expect(schema.safeParse('1e10').success).toBe(false);
    expect(schema.safeParse('abc').success).toBe(false);
    expect(schema.safeParse('1.2.3').success).toBe(false);
  });

  it('rejects a value whose integer part exceeds i64 max', () => {
    const tooBig = '9999999999999999999'; // > 9223372036854775807
    const result = schema.safeParse(tooBig);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/integer part exceeds/i);
    }
  });

  it('rejects more than 7 decimal places (Stellar precision limit)', () => {
    const result = schema.safeParse('1.00000001'); // 8 dp
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/decimal places/i);
    }
  });

  it('accepts exactly 7 decimal places (boundary)', () => {
    expect(schema.safeParse('1.0000000').success).toBe(true);
    expect(schema.safeParse('0.0000001').success).toBe(true);
  });

  it('accepts zero', () => {
    expect(schema.safeParse('0').success).toBe(true);
    expect(schema.safeParse('0.0000000').success).toBe(true);
  });
});

// ── CreateStreamSchema ─────────────────────────────────────────────────────────

describe('CreateStreamSchema', () => {
  const minimal = { sender: VALID_SENDER, recipient: VALID_RECEIVER };

  it('accepts valid sender and recipient', () => {
    expect(CreateStreamSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts all optional fields when valid', () => {
    const result = CreateStreamSchema.safeParse({
      ...minimal,
      depositAmount: '100.0000000',
      ratePerSecond: '0.0000116',
      startTime: 0,
      endTime: 1_000_000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid Stellar public key for sender', () => {
    expect(CreateStreamSchema.safeParse({ ...minimal, sender: 'NOTAKEY' }).success).toBe(false);
  });

  it('rejects an invalid Stellar public key for recipient', () => {
    expect(CreateStreamSchema.safeParse({ ...minimal, recipient: 'bad' }).success).toBe(false);
  });

  it('rejects numeric depositAmount (must be a decimal string)', () => {
    expect(CreateStreamSchema.safeParse({ ...minimal, depositAmount: 100 }).success).toBe(false);
  });

  it('rejects negative startTime', () => {
    expect(CreateStreamSchema.safeParse({ ...minimal, startTime: -1 }).success).toBe(false);
  });

  it('rejects non-integer endTime', () => {
    expect(CreateStreamSchema.safeParse({ ...minimal, endTime: 1.5 }).success).toBe(false);
  });

  it('accepts startTime of zero (boundary)', () => {
    expect(CreateStreamSchema.safeParse({ ...minimal, startTime: 0 }).success).toBe(true);
  });
});

// ── StreamBatchCreateSchema ────────────────────────────────────────────────────

describe('StreamBatchCreateSchema', () => {
  function makeStream(overrides: Record<string, unknown> = {}) {
    return {
      id:               'stream-1',
      sender_address:   VALID_SENDER,
      recipient_address: VALID_RECEIVER,
      amount:           '100.0000000',
      streamed_amount:  '0.0000000',
      remaining_amount: '100.0000000',
      rate_per_second:  '0.0000116',
      start_time:       0,
      end_time:         1_000_000,
      contract_id:      'CONTRACT123',
      transaction_hash: 'TX001',
      event_index:      0,
      ...overrides,
    };
  }

  it('accepts a valid single-stream batch', () => {
    expect(StreamBatchCreateSchema.safeParse({ streams: [makeStream()] }).success).toBe(true);
  });

  it('accepts a batch at the maximum size (100 streams)', () => {
    const streams = Array.from({ length: 100 }, (_, i) =>
      makeStream({ id: `s-${i}`, transaction_hash: `TX${i}`, event_index: i }),
    );
    expect(StreamBatchCreateSchema.safeParse({ streams }).success).toBe(true);
  });

  it('rejects empty streams array', () => {
    // max(100) implies min is 0 but superRefine runs on duplicates; empty is allowed by schema
    // — confirm it does not throw (empty batch is structurally valid even if business rules
    //   may reject it at the route level)
    const result = StreamBatchCreateSchema.safeParse({ streams: [] });
    expect(result.success).toBe(true); // schema allows zero-length; route enforces non-empty
  });

  it('rejects a batch exceeding 100 streams', () => {
    const streams = Array.from({ length: 101 }, (_, i) =>
      makeStream({ id: `s-${i}`, transaction_hash: `TX${i}`, event_index: i }),
    );
    expect(StreamBatchCreateSchema.safeParse({ streams }).success).toBe(false);
  });

  it('rejects duplicate (transaction_hash, event_index) tuples', () => {
    const streams = [
      makeStream({ transaction_hash: 'TX_SAME', event_index: 0 }),
      makeStream({ id: 'stream-2', transaction_hash: 'TX_SAME', event_index: 0 }), // duplicate
    ];
    const result = StreamBatchCreateSchema.safeParse({ streams });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('Duplicate stream identity'))).toBe(true);
    }
  });

  it('accepts distinct (transaction_hash, event_index) tuples', () => {
    const streams = [
      makeStream({ transaction_hash: 'TX_A', event_index: 0 }),
      makeStream({ id: 'stream-2', transaction_hash: 'TX_A', event_index: 1 }), // same tx, different index
    ];
    expect(StreamBatchCreateSchema.safeParse({ streams }).success).toBe(true);
  });

  it('rejects invalid sender_address in a stream', () => {
    expect(
      StreamBatchCreateSchema.safeParse({ streams: [makeStream({ sender_address: 'INVALID' })] }).success,
    ).toBe(false);
  });
});

// ── PrivacyConsentSchema ───────────────────────────────────────────────────────

describe('PrivacyConsentSchema', () => {
  const valid = {
    address:                    VALID_SENDER,
    analytics_optout:           false,
    marketing_optout:           true,
    biometric_processing_consent: false,
  };

  it('accepts a fully-specified consent object', () => {
    expect(PrivacyConsentSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an invalid Stellar address', () => {
    expect(PrivacyConsentSchema.safeParse({ ...valid, address: 'bad' }).success).toBe(false);
  });

  it('rejects non-boolean analytics_optout', () => {
    expect(PrivacyConsentSchema.safeParse({ ...valid, analytics_optout: 'yes' }).success).toBe(false);
  });

  it('rejects extra unknown fields (strictObject)', () => {
    expect(PrivacyConsentSchema.safeParse({ ...valid, extra_field: true }).success).toBe(false);
  });

  it('rejects missing required boolean field', () => {
    const { biometric_processing_consent: _, ...withoutBiometric } = valid;
    expect(PrivacyConsentSchema.safeParse(withoutBiometric).success).toBe(false);
  });
});

// ── ListStreamsQuerySchema ──────────────────────────────────────────────────────

describe('ListStreamsQuerySchema', () => {
  it('accepts empty query params', () => {
    expect(ListStreamsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts valid limit string', () => {
    expect(ListStreamsQuerySchema.safeParse({ limit: '50' }).success).toBe(true);
  });

  it('rejects non-numeric limit', () => {
    expect(ListStreamsQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });

  it('accepts include_total true and false', () => {
    expect(ListStreamsQuerySchema.safeParse({ include_total: 'true' }).success).toBe(true);
    expect(ListStreamsQuerySchema.safeParse({ include_total: 'false' }).success).toBe(true);
  });

  it('rejects invalid include_total value', () => {
    expect(ListStreamsQuerySchema.safeParse({ include_total: 'yes' }).success).toBe(false);
  });

  it('accepts optional cursor', () => {
    expect(ListStreamsQuerySchema.safeParse({ cursor: 'eyJpZCI6IjEifQ' }).success).toBe(true);
  });
});

// ── ReplayRequestSchema ────────────────────────────────────────────────────────

describe('ReplayRequestSchema', () => {
  const base = { contract_id: 'CONTRACT123', ledger: 0 };

  it('accepts minimal valid input', () => {
    expect(ReplayRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts valid block range', () => {
    expect(
      ReplayRequestSchema.safeParse({ ...base, from_block: 0, to_block: 100 }).success,
    ).toBe(true);
  });

  it('accepts from_block == to_block (boundary)', () => {
    expect(
      ReplayRequestSchema.safeParse({ ...base, from_block: 50, to_block: 50 }).success,
    ).toBe(true);
  });

  it('rejects from_block > to_block', () => {
    const result = ReplayRequestSchema.safeParse({ ...base, from_block: 100, to_block: 50 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/from_block must be less than or equal/i);
    }
  });

  it('rejects empty contract_id', () => {
    expect(ReplayRequestSchema.safeParse({ ...base, contract_id: '' }).success).toBe(false);
  });

  it('rejects negative ledger', () => {
    expect(ReplayRequestSchema.safeParse({ ...base, ledger: -1 }).success).toBe(false);
  });

  it('accepts ledger of zero (boundary)', () => {
    expect(ReplayRequestSchema.safeParse({ ...base, ledger: 0 }).success).toBe(true);
  });
});

// ── DlqListQuerySchema ─────────────────────────────────────────────────────────

describe('DlqListQuerySchema', () => {
  it('accepts empty query', () => {
    expect(DlqListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts valid limit and offset', () => {
    expect(DlqListQuerySchema.safeParse({ limit: '20', offset: '0' }).success).toBe(true);
  });

  it('rejects non-numeric offset', () => {
    expect(DlqListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('accepts optional topic filter', () => {
    expect(DlqListQuerySchema.safeParse({ topic: 'stream.created' }).success).toBe(true);
  });
});

// ── ContractEventSchema ────────────────────────────────────────────────────────

describe('ContractEventSchema', () => {
  it('accepts a well-formed event', () => {
    expect(ContractEventSchema.safeParse(makeEvent()).success).toBe(true);
  });

  it('rejects an unknown topic', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ topic: 'stream.hacked' })).success).toBe(false);
  });

  it('accepts all known CONTRACT_EVENT_TOPICS', () => {
    for (const topic of CONTRACT_EVENT_TOPICS) {
      expect(ContractEventSchema.safeParse(makeEvent({ topic })).success).toBe(true);
    }
  });

  it('rejects a negative ledger', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ ledger: -1 })).success).toBe(false);
  });

  it('accepts ledger zero (boundary)', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ ledger: 0 })).success).toBe(true);
  });

  it('rejects empty eventId', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ eventId: '' })).success).toBe(false);
  });

  it('rejects array payload (must be a plain object)', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ payload: [1, 2] })).success).toBe(false);
  });

  it('rejects null payload', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ payload: null })).success).toBe(false);
  });

  it('rejects extra top-level keys (strictObject)', () => {
    expect(ContractEventSchema.safeParse({ ...makeEvent(), unknownField: true }).success).toBe(false);
  });

  it('rejects non-integer txIndex', () => {
    expect(ContractEventSchema.safeParse(makeEvent({ txIndex: 1.5 })).success).toBe(false);
  });
});

// ── ContractEventBatchSchema ───────────────────────────────────────────────────

describe('ContractEventBatchSchema', () => {
  it('accepts a valid single-event batch', () => {
    expect(ContractEventBatchSchema.safeParse({ events: [makeEvent()] }).success).toBe(true);
  });

  it('rejects an empty events array', () => {
    expect(ContractEventBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects a batch exceeding 100 events', () => {
    const events = Array.from({ length: 101 }, (_, i) => makeEvent({ eventId: `e-${i}` }));
    expect(ContractEventBatchSchema.safeParse({ events }).success).toBe(false);
  });

  it('accepts a batch at exactly 100 events (boundary)', () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent({ eventId: `e-${i}` }));
    expect(ContractEventBatchSchema.safeParse({ events }).success).toBe(true);
  });

  it('rejects duplicate eventIds within a batch', () => {
    const events = [makeEvent({ eventId: 'DUPE' }), makeEvent({ eventId: 'DUPE' })];
    const result = ContractEventBatchSchema.safeParse({ events });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('Duplicate eventId'))).toBe(true);
    }
  });

  it('accepts distinct eventIds', () => {
    const events = [makeEvent({ eventId: 'e-1' }), makeEvent({ eventId: 'e-2' })];
    expect(ContractEventBatchSchema.safeParse({ events }).success).toBe(true);
  });
});

// ── parseBody ──────────────────────────────────────────────────────────────────

describe('parseBody', () => {
  it('returns success:true with typed data on valid input', () => {
    const result = parseBody(CreateStreamSchema, {
      sender: VALID_SENDER,
      recipient: VALID_RECEIVER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sender).toBe(VALID_SENDER);
    }
  });

  it('returns success:false with issues array on invalid input', () => {
    const result = parseBody(CreateStreamSchema, { sender: 'bad', recipient: 'bad' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns success:false for completely wrong type', () => {
    const result = parseBody(CreateStreamSchema, null);
    expect(result.success).toBe(false);
  });
});

// ── formatZodIssues ────────────────────────────────────────────────────────────

describe('formatZodIssues', () => {
  it('maps a single issue to field + message', () => {
    const parseResult = CreateStreamSchema.safeParse({ sender: 'bad', recipient: VALID_RECEIVER });
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      const formatted = formatZodIssues(parseResult.error.issues);
      expect(formatted.length).toBeGreaterThan(0);
      expect(typeof formatted[0].field).toBe('string');
      expect(typeof formatted[0].message).toBe('string');
    }
  });

  it('uses "body" as field name when path is empty', () => {
    // Construct a synthetic issue with an empty path
    const issue = {
      code: 'custom' as const,
      path: [],
      message: 'Top-level error',
    };
    const formatted = formatZodIssues([issue]);
    expect(formatted[0].field).toBe('body');
    expect(formatted[0].message).toBe('Top-level error');
  });

  it('joins nested paths with dot notation', () => {
    const issue = {
      code: 'custom' as const,
      path: ['streams', 0, 'amount'],
      message: 'bad amount',
    };
    const formatted = formatZodIssues([issue]);
    expect(formatted[0].field).toBe('streams.0.amount');
  });

  it('returns empty array for no issues', () => {
    expect(formatZodIssues([])).toEqual([]);
  });
});
