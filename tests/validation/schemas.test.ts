import { describe, expect, it } from 'vitest';

import { MAX_DECIMAL_INTEGER_PART, STELLAR_DECIMALS } from '../../src/serialization/decimal.js';
import { CreateStreamSchema, StreamBatchCreateSchema } from '../../src/validation/schemas.js';

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

const validCreateStreamBody = {
  sender: VALID_SENDER,
  recipient: VALID_RECIPIENT,
  depositAmount: '1000.0000000',
  ratePerSecond: '0.0000116',
};

function makeBatchStream(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stream-tx-0-0',
    sender_address: VALID_SENDER,
    recipient_address: VALID_RECIPIENT,
    amount: '1000.0000000',
    streamed_amount: '0',
    remaining_amount: '1000.0000000',
    rate_per_second: '0.0000116',
    start_time: 1700000000,
    end_time: 0,
    contract_id: 'api-created',
    transaction_hash: 'tx-0',
    event_index: 0,
    ...overrides,
  };
}

function issueMessages(result: ReturnType<typeof CreateStreamSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

describe('validation schemas', () => {
  describe('decimal string amount bounds', () => {
    it('accepts the maximum supported integer magnitude with Stellar precision', () => {
      const result = CreateStreamSchema.safeParse({
        ...validCreateStreamBody,
        depositAmount: `${MAX_DECIMAL_INTEGER_PART.toString()}.${'0'.repeat(STELLAR_DECIMALS)}`,
      });

      expect(result.success).toBe(true);
    });

    it('rejects create-stream values above the supported integer magnitude', () => {
      const result = CreateStreamSchema.safeParse({
        ...validCreateStreamBody,
        depositAmount: `${(MAX_DECIMAL_INTEGER_PART + 1n).toString()}.0000000`,
      });

      expect(result.success).toBe(false);
      expect(issueMessages(result)).toContain(
        `depositAmount exceeds maximum supported integer value ${MAX_DECIMAL_INTEGER_PART.toString()}`,
      );
    });

    it('rejects create-stream fractional precision beyond Stellar stroops', () => {
      const result = CreateStreamSchema.safeParse({
        ...validCreateStreamBody,
        ratePerSecond: '0.00000001',
      });

      expect(result.success).toBe(false);
      expect(issueMessages(result)).toContain(`ratePerSecond must have at most ${STELLAR_DECIMALS} decimal places`);
    });

    it('applies the same decimal bounds to indexed stream batches', () => {
      const result = StreamBatchCreateSchema.safeParse({
        streams: [
          makeBatchStream({
            amount: `${(MAX_DECIMAL_INTEGER_PART + 1n).toString()}`,
            remaining_amount: '100.00000001',
          }),
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ['streams', 0, 'amount'],
              message: `amount exceeds maximum supported integer value ${MAX_DECIMAL_INTEGER_PART.toString()}`,
            }),
            expect.objectContaining({
              path: ['streams', 0, 'remaining_amount'],
              message: `remaining_amount must have at most ${STELLAR_DECIMALS} decimal places`,
            }),
          ]),
        );
      }
    });
  });
});
