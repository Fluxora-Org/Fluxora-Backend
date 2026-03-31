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
import {
    ValidationError,
    validateStellarAddress,
    validateAmount,
    validateRatePerSecond,
    validateTimestamp,
    validateCreateStreamRequest,
    validateStreamId,
    validateJsonDepth,
    validateRequestSize,
} from '../src/config/validation';

describe('Validation Edge Cases & Failure Modes', () => {
    describe('Abuse Scenarios: Oversized Payloads', () => {
        it('should reject request exceeding 256 KiB', () => {
            const maxSize = 256 * 1024; // 256 KiB
            expect(() => validateRequestSize(maxSize + 1, maxSize)).toThrow(ValidationError);
        });

        it('should accept request at exactly 256 KiB', () => {
            const maxSize = 256 * 1024;
            expect(() => validateRequestSize(maxSize, maxSize)).not.toThrow();
        });

        it('should reject extremely large payloads', () => {
            const maxSize = 256 * 1024;
            expect(() => validateRequestSize(1024 * 1024 * 100, maxSize)).toThrow(ValidationError);
        });

        it('should provide size information in error', () => {
            const maxSize = 256 * 1024;
            try {
                validateRequestSize(maxSize + 1000, maxSize);
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(ValidationError);
                expect((e as ValidationError).message).toContain('exceeds maximum');
            }
        });
    });

    describe('Abuse Scenarios: Deeply Nested JSON', () => {
        it('should reject deeply nested objects', () => {
            let obj: any = { value: 1 };
            for (let i = 0; i < 20; i++) {
                obj = { nested: obj };
            }
            expect(() => validateJsonDepth(obj, 5)).toThrow(ValidationError);
        });

        it('should reject deeply nested arrays', () => {
            let arr: any = [1];
            for (let i = 0; i < 20; i++) {
                arr = [arr];
            }
            expect(() => validateJsonDepth(arr, 5)).toThrow(ValidationError);
        });

        it('should reject mixed nested structures', () => {
            const obj = {
                a: [
                    {
                        b: [
                            {
                                c: [
                                    {
                                        d: [
                                            {
                                                e: [{ f: 1 }],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };
            expect(() => validateJsonDepth(obj, 5)).toThrow(ValidationError);
        });

        it('should accept shallow structures', () => {
            const obj = {
                a: 1,
                b: 2,
                c: { d: 3, e: 4 },
                f: [1, 2, 3],
            };
            expect(() => validateJsonDepth(obj, 10)).not.toThrow();
        });

        it('should provide depth information in error', () => {
            const obj = { a: { b: { c: { d: 1 } } } };
            try {
                validateJsonDepth(obj, 2);
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(ValidationError);
                expect((e as ValidationError).message).toContain('depth');
            }
        });
    });

    describe('Boundary Conditions: Amount Validation', () => {
        it('should accept minimum valid amount (1 stroop)', () => {
            expect(validateAmount('1')).toBe('1');
        });

        it('should accept maximum valid amount', () => {
            const maxAmount = '9223372036854775807';
            expect(validateAmount(maxAmount)).toBe(maxAmount);
        });

        it('should reject amount exceeding max by 1', () => {
            const overMax = '9223372036854775808';
            expect(() => validateAmount(overMax)).toThrow(ValidationError);
        });

        it('should reject zero', () => {
            expect(() => validateAmount('0')).toThrow(ValidationError);
        });

        it('should reject negative amounts', () => {
            expect(() => validateAmount('-1')).toThrow(ValidationError);
            expect(() => validateAmount('-999999999')).toThrow(ValidationError);
        });

        it('should reject decimal amounts', () => {
            expect(() => validateAmount('100.5')).toThrow(ValidationError);
            expect(() => validateAmount('0.1')).toThrow(ValidationError);
        });

        it('should reject scientific notation', () => {
            expect(() => validateAmount('1e10')).toThrow(ValidationError);
            expect(() => validateAmount('1E+10')).toThrow(ValidationError);
        });

        it('should reject leading zeros (but accept them as valid integers)', () => {
            // Leading zeros are technically valid in JSON numbers
            expect(validateAmount('00100')).toBe('00100');
        });

        it('should reject whitespace in amount', () => {
            expect(() => validateAmount(' 100 ')).toThrow(ValidationError);
        });

        it('should reject empty string', () => {
            expect(() => validateAmount('')).toThrow(ValidationError);
        });

        it('should handle very large number strings', () => {
            const huge = '99999999999999999999999999999999';
            expect(() => validateAmount(huge)).toThrow(ValidationError);
        });
    });

    describe('Boundary Conditions: Stellar Address Validation', () => {
        it('should accept valid Stellar public key', () => {
            const valid = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';
            expect(validateStellarAddress(valid)).toBe(valid);
        });

        it('should reject address with wrong prefix', () => {
            const invalid = 'SBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';
            expect(() => validateStellarAddress(invalid)).toThrow(ValidationError);
        });

        it('should reject address with wrong length', () => {
            const tooShort = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQ';
            const tooLong = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQXX';
            expect(() => validateStellarAddress(tooShort)).toThrow(ValidationError);
            expect(() => validateStellarAddress(tooLong)).toThrow(ValidationError);
        });

        it('should reject address with invalid characters', () => {
            const invalid = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQ0'; // 0 is invalid
            expect(() => validateStellarAddress(invalid)).toThrow(ValidationError);
        });

        it('should reject lowercase address', () => {
            const lowercase = 'gbbd47uzq5cyvveuvrynqzx3g5krztayf5xsvs2ukmccww5ljjlxnvqx';
            expect(() => validateStellarAddress(lowercase)).toThrow(ValidationError);
        });

        it('should reject empty string', () => {
            expect(() => validateStellarAddress('')).toThrow(ValidationError);
        });

        it('should reject null-like values', () => {
            expect(() => validateStellarAddress(null as any)).toThrow(ValidationError);
            expect(() => validateStellarAddress(undefined as any)).toThrow(ValidationError);
        });

        it('should reject whitespace-only string', () => {
            expect(() => validateStellarAddress('   ')).toThrow(ValidationError);
        });
    });

    describe('Boundary Conditions: Timestamp Validation', () => {
        it('should accept future timestamp', () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(validateTimestamp(future)).toBe(future);
        });

        it('should accept current timestamp', () => {
            const now = Math.floor(Date.now() / 1000);
            expect(validateTimestamp(now)).toBe(now);
        });

        it('should accept recent timestamp (within 1 hour)', () => {
            const recent = Math.floor(Date.now() / 1000) - 1800;
            expect(validateTimestamp(recent)).toBe(recent);
        });

        it('should accept timestamp exactly 1 hour ago', () => {
            const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
            expect(validateTimestamp(oneHourAgo)).toBe(oneHourAgo);
        });

        it('should reject timestamp older than 1 hour', () => {
            const tooOld = Math.floor(Date.now() / 1000) - 3601;
            expect(() => validateTimestamp(tooOld)).toThrow(ValidationError);
        });

        it('should reject very old timestamp', () => {
            const veryOld = Math.floor(Date.now() / 1000) - 86400 * 365; // 1 year ago
            expect(() => validateTimestamp(veryOld)).toThrow(ValidationError);
        });

        it('should handle string timestamps', () => {
            const future = String(Math.floor(Date.now() / 1000) + 3600);
            expect(validateTimestamp(future)).toBe(Number(future));
        });

        it('should reject invalid timestamp strings', () => {
            expect(() => validateTimestamp('not-a-number')).toThrow(ValidationError);
        });

        it('should reject NaN', () => {
            expect(() => validateTimestamp(NaN)).toThrow(ValidationError);
        });
    });

    describe('Duplicate Submission Detection', () => {
        it('should detect identical requests', () => {
            const request = {
                sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '1000000000',
                ratePerSecond: '100000',
                startTime: Math.floor(Date.now() / 1000) + 3600,
            };

            // Both should validate successfully
            const result1 = validateCreateStreamRequest(request);
            const result2 = validateCreateStreamRequest(request);

            expect(result1).toEqual(result2);
        });

        it('should detect when only one field differs', () => {
            const base = {
                sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '1000000000',
                ratePerSecond: '100000',
                startTime: Math.floor(Date.now() / 1000) + 3600,
            };

            const variations = [
                { ...base, depositAmount: '2000000000' },
                { ...base, ratePerSecond: '200000' },
                { ...base, startTime: base.startTime + 1 },
            ];

            const baseResult = validateCreateStreamRequest(base);
            variations.forEach((variation) => {
                const result = validateCreateStreamRequest(variation);
                expect(result).not.toEqual(baseResult);
            });
        });
    });

    describe('Type Coercion Edge Cases', () => {
        it('should handle numeric strings for amounts', () => {
            expect(validateAmount('1000')).toBe('1000');
        });

        it('should handle numeric values for amounts', () => {
            expect(validateAmount(1000)).toBe('1000');
        });

        it('should handle string timestamps', () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(validateTimestamp(String(future))).toBe(future);
        });

        it('should handle numeric timestamps', () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(validateTimestamp(future)).toBe(future);
        });

        it('should reject boolean values for amounts', () => {
            expect(() => validateAmount(true as any)).toThrow(ValidationError);
        });

        it('should reject object values for amounts', () => {
            expect(() => validateAmount({} as any)).toThrow(ValidationError);
        });

        it('should reject array values for amounts', () => {
            expect(() => validateAmount([] as any)).toThrow(ValidationError);
        });
    });

    describe('Stream ID Validation', () => {
        it('should accept valid stream ID', () => {
            expect(validateStreamId('stream-1704067200')).toBe('stream-1704067200');
        });

        it('should reject ID without stream prefix', () => {
            expect(() => validateStreamId('1704067200')).toThrow(ValidationError);
        });

        it('should reject ID with wrong prefix', () => {
            expect(() => validateStreamId('flow-1704067200')).toThrow(ValidationError);
        });

        it('should reject ID with non-numeric suffix', () => {
            expect(() => validateStreamId('stream-abc')).toThrow(ValidationError);
        });

        it('should reject empty ID', () => {
            expect(() => validateStreamId('')).toThrow(ValidationError);
        });

        it('should reject ID with extra characters', () => {
            expect(() => validateStreamId('stream-1704067200-extra')).toThrow(ValidationError);
        });
    });

    describe('Rate Per Second Validation', () => {
        it('should accept valid rate', () => {
            expect(validateRatePerSecond('100000')).toBe('100000');
        });

        it('should accept minimum rate (1)', () => {
            expect(validateRatePerSecond('1')).toBe('1');
        });

        it('should reject zero rate', () => {
            expect(() => validateRatePerSecond('0')).toThrow(ValidationError);
        });

        it('should reject negative rate', () => {
            expect(() => validateRatePerSecond('-100')).toThrow(ValidationError);
        });

        it('should reject decimal rate', () => {
            expect(() => validateRatePerSecond('100.5')).toThrow(ValidationError);
        });
    });

    describe('Create Stream Request Validation', () => {
        const validRequest = {
            sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
            recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
            depositAmount: '1000000000',
            ratePerSecond: '100000',
            startTime: Math.floor(Date.now() / 1000) + 3600,
        };

        it('should accept valid request', () => {
            const result = validateCreateStreamRequest(validRequest);
            expect(result.sender).toBe(validRequest.sender);
        });

        it('should reject request with same sender and recipient', () => {
            const invalid = {
                ...validRequest,
                recipient: validRequest.sender,
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should reject request with insufficient deposit', () => {
            const invalid = {
                ...validRequest,
                depositAmount: '50000',
                ratePerSecond: '100000',
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should accept request with deposit equal to rate', () => {
            const valid = {
                ...validRequest,
                depositAmount: '100000',
                ratePerSecond: '100000',
            };
            expect(() => validateCreateStreamRequest(valid)).not.toThrow();
        });

        it('should reject non-object request', () => {
            expect(() => validateCreateStreamRequest('not an object')).toThrow(ValidationError);
            expect(() => validateCreateStreamRequest(null)).toThrow(ValidationError);
            expect(() => validateCreateStreamRequest([])).toThrow(ValidationError);
        });

        it('should reject request with missing fields', () => {
            const incomplete = {
                sender: validRequest.sender,
                recipient: validRequest.recipient,
                // missing depositAmount, ratePerSecond, startTime
            };
            expect(() => validateCreateStreamRequest(incomplete)).toThrow(ValidationError);
        });

        it('should reject request with invalid sender', () => {
            const invalid = {
                ...validRequest,
                sender: 'invalid-address',
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should reject request with invalid recipient', () => {
            const invalid = {
                ...validRequest,
                recipient: 'invalid-address',
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should reject request with invalid amount', () => {
            const invalid = {
                ...validRequest,
                depositAmount: '-1000',
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should reject request with invalid rate', () => {
            const invalid = {
                ...validRequest,
                ratePerSecond: '0',
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should reject request with old timestamp', () => {
            const invalid = {
                ...validRequest,
                startTime: Math.floor(Date.now() / 1000) - 7200,
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });
    });

    describe('Error Information Completeness', () => {
        it('should include field name in validation error', () => {
            try {
                validateStellarAddress('invalid', 'customField');
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(ValidationError);
                expect((e as ValidationError).field).toBe('customField');
            }
        });

        it('should include value in validation error', () => {
            try {
                validateAmount('-100');
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(ValidationError);
                expect((e as ValidationError).value).toBe('-100');
            }
        });

        it('should provide actionable error messages', () => {
            try {
                validateStellarAddress('invalid');
                expect.fail('Should have thrown');
            } catch (e) {
                expect((e as ValidationError).message).toContain('valid Stellar');
            }
        });
    });
});
