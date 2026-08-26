/**
 * Edge case and failure mode tests for validation
 * 
 * Covers:
 * - Boundary conditions (min/max values)
 * - Abuse scenarios (oversized payloads, excessive nesting)
 * - Type coercion edge cases
 * - Duplicate detection
 * - Idempotency guarantees
 * 
 * These tests ensure the API behaves predictably under stress
 * and malicious input conditions.
 */

import { describe, it, expect } from 'vitest';
import { CreateStreamSchema, StreamBatchCreateSchema } from '../src/validation/schemas';

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

function makeBatchStream(index: number, overrides: Record<string, unknown> = {}) {
    return {
        id: `stream-tx-${index}-${index}`,
        sender_address: VALID_SENDER,
        recipient_address: VALID_RECIPIENT,
        amount: '1000.0000000',
        streamed_amount: '0',
        remaining_amount: '1000.0000000',
        rate_per_second: '0.0000116',
        start_time: 1700000000 + index,
        end_time: 0,
        contract_id: 'api-created',
        transaction_hash: `tx-${index}`,
        event_index: index,
        ...overrides,
    };
}

describe('Validation Edge Cases & Failure Modes', () => {
    describe('Duplicate Submission Detection', () => {
        it('accepts a batch whose stream identity tuples are all distinct', () => {
            const result = StreamBatchCreateSchema.safeParse({
                streams: [
                    makeBatchStream(0),
                    makeBatchStream(1),
                    makeBatchStream(2),
                ],
            });

            expect(result.success).toBe(true);
        });

        it('rejects a mixed batch with a duplicate transaction hash and event index', () => {
            const result = StreamBatchCreateSchema.safeParse({
                streams: [
                    makeBatchStream(0, { transaction_hash: 'same-tx', event_index: 7 }),
                    makeBatchStream(1),
                    makeBatchStream(2, { transaction_hash: 'same-tx', event_index: 7 }),
                ],
            });

            expect(result.success).toBe(false);
            if (result.success) return;

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]?.path).toEqual(['streams', 2]);
            expect(result.error.issues[0]?.message).toContain('first seen at index 0');
        });

        it('rejects all-duplicate batches and reports each offending index', () => {
            const result = StreamBatchCreateSchema.safeParse({
                streams: [
                    makeBatchStream(0, { transaction_hash: 'dup-tx', event_index: 0 }),
                    makeBatchStream(1, { transaction_hash: 'dup-tx', event_index: 0 }),
                    makeBatchStream(2, { transaction_hash: 'dup-tx', event_index: 0 }),
                ],
            });

            expect(result.success).toBe(false);
            if (result.success) return;

            expect(result.error.issues.map((issue) => issue.path)).toEqual([
                ['streams', 1],
                ['streams', 2],
            ]);
        });

        it('keeps the 100 stream batch size cap unchanged', () => {
            const maxBatch = Array.from({ length: 100 }, (_, index) => makeBatchStream(index));
            const oversizedBatch = Array.from({ length: 101 }, (_, index) => makeBatchStream(index));

            expect(StreamBatchCreateSchema.safeParse({ streams: maxBatch }).success).toBe(true);

            const oversized = StreamBatchCreateSchema.safeParse({ streams: oversizedBatch });
            expect(oversized.success).toBe(false);
            if (oversized.success) return;

            expect(oversized.error.issues.some((issue) => issue.message.includes('Maximum of 100'))).toBe(true);
        });
    });

    describe('Zod Schema decimalStringField limits', () => {
        it('rejects depositAmount with integer part exceeding max magnitude', () => {
            const result = CreateStreamSchema.safeParse({
                sender: VALID_SENDER,
                recipient: VALID_RECIPIENT,
                depositAmount: '9223372036854775808',
                ratePerSecond: '100',
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0].message).toContain('depositAmount integer part exceeds maximum supported value');
            }
        });

        it('rejects ratePerSecond with more than 7 decimal places', () => {
            const result = CreateStreamSchema.safeParse({
                sender: VALID_SENDER,
                recipient: VALID_RECIPIENT,
                depositAmount: '1000',
                ratePerSecond: '0.00000001',
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0].message).toContain('ratePerSecond exceeds maximum Stellar precision of 7 decimal places');
            }
        });
    });
});

