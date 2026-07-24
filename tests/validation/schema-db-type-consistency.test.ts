/**
 * Cross-checks validation schemas (src/validation/schemas.ts) against
 * DB-facing types (src/db/types.ts) to prevent silent drift.
 */

import { describe, it, expect } from 'vitest';
import {
  StreamBatchCreateSchema,
  ContractEventSchema,
} from '../../src/validation/schemas.js';

/**
 * Allowlist of intentional differences between schemas and DB types.
 * Keys are entity names, values are arrays of field names that are allowed
 * to exist in one but not the other, with comments explaining why.
 */
const ALLOWLIST = {
  /** Stream-related differences */
  stream: [],

  /** Contract event-related differences */
  contractEvent: [
    /** ingestedAt is an internal DB field set at ingestion time, not part of input schema */
    'ingestedAt',
  ],

  /** Stream record differences */
  streamRecord: [
    /** status, created_at, updated_at are internal DB fields */
    'status',
    'created_at',
    'updated_at',
  ],
} as const;

describe('schema-db type consistency', () => {
  describe('stream schema vs db type', () => {
    it('should have matching field names', () => {
      // Get stream schema keys from validation schema
      const streamSchema = StreamBatchCreateSchema.shape.streams.element;
      const schemaKeys = Object.keys(streamSchema.shape).sort();

      // Get DB CreateStreamInput keys (mirroring the type)
      const dbCreateStreamKeys = [
        'id',
        'sender_address',
        'recipient_address',
        'amount',
        'streamed_amount',
        'remaining_amount',
        'rate_per_second',
        'start_time',
        'end_time',
        'contract_id',
        'transaction_hash',
        'event_index',
      ].sort();

      // Check that schema keys match DB keys
      expect(schemaKeys).toEqual(dbCreateStreamKeys);
    });
  });

  describe('contract event schema vs db type', () => {
    it('should have matching field names (with allowlist)', () => {
      // Get contract event schema keys
      const schemaKeys = Object.keys(ContractEventSchema.shape).sort();

      // Get DB StreamEventRecord keys (mirroring the type)
      const dbStreamEventKeys = [
        'eventId',
        'ledger',
        'ledgerHash',
        'contractId',
        'topic',
        'txHash',
        'txIndex',
        'operationIndex',
        'eventIndex',
        'payload',
        'happenedAt',
        'ingestedAt',
      ].sort();

      // Filter out allowlisted fields from DB keys
      const filteredDbKeys = dbStreamEventKeys.filter(
        (key) => !ALLOWLIST.contractEvent.includes(key as any),
      );

      // Check that schema keys match filtered DB keys
      expect(schemaKeys).toEqual(filteredDbKeys);
    });
  });
});
