import { describe, it, expect } from '@jest/globals';
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
} from './validation';

describe('Validation Module', () => {
    describe('validateStellarAddress', () => {
        // Valid Stellar public key: G + exactly 55 chars from [A-Z2-7]
        const VALID_ADDR_A = 'G' + 'A'.repeat(55);
        const VALID_ADDR_B = 'G' + 'B'.repeat(55);

        it('should accept valid Stellar address', () => {
            const address = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';
            expect(validateStellarAddress(address)).toBe(address);
        });

        it('should reject invalid address format', () => {
            expect(() => validateStellarAddress('invalid')).toThrow(ValidationError);
        });

        it('should reject non-string address', () => {
            expect(() => validateStellarAddress('')).toThrow(ValidationError);
        });
    });

    describe('validateAmount', () => {
        it('should accept valid positive amount', () => {
            expect(validateAmount('1000')).toBe('1000');
        });

        it('should reject zero amount', () => {
            expect(() => validateAmount('0')).toThrow(ValidationError);
        });

        it('should reject negative amount', () => {
            expect(() => validateAmount('-100')).toThrow(ValidationError);
        });

        it('should reject non-numeric amount', () => {
            expect(() => validateAmount('abc')).toThrow(ValidationError);
        });

        it('should accept large amounts within Stellar limits', () => {
            expect(validateAmount('9223372036854775807')).toBe('9223372036854775807');
        });

        it('should reject amounts exceeding Stellar max', () => {
            expect(() => validateAmount('9223372036854775808')).toThrow(ValidationError);
        });
    });

    describe('validateRatePerSecond', () => {
        it('should accept valid rate', () => {
            expect(validateRatePerSecond('100')).toBe('100');
        });

        it('should reject zero rate', () => {
            expect(() => validateRatePerSecond('0')).toThrow(ValidationError);
        });

        it('should reject negative rate', () => {
            expect(() => validateRatePerSecond('-50')).toThrow(ValidationError);
        });
    });

    describe('validateTimestamp', () => {
        it('should accept future timestamp', () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(validateTimestamp(future)).toBe(future);
        });

        it('should accept recent timestamp (within 1 hour)', () => {
            const recent = Math.floor(Date.now() / 1000) - 1800;
            expect(validateTimestamp(recent)).toBe(recent);
        });

        it('should reject old timestamp (older than 1 hour)', () => {
            const old = Math.floor(Date.now() / 1000) - 7200;
            expect(() => validateTimestamp(old)).toThrow(ValidationError);
        });
    });

    describe('validateCreateStreamRequest', () => {
        const VALID_ADDR_A = 'G' + 'A'.repeat(55);
        const VALID_ADDR_B = 'G' + 'B'.repeat(55);
        const validRequest = {
            sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
            recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
            depositAmount: '1000',
            ratePerSecond: '100',
            startTime: Math.floor(Date.now() / 1000) + 3600,
        };

        it('should accept valid stream request', () => {
            const result = validateCreateStreamRequest(validRequest);
            expect(result.sender).toBe(validRequest.sender);
            expect(result.recipient).toBe(validRequest.recipient);
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
                depositAmount: '50',
                ratePerSecond: '100',
            };
            expect(() => validateCreateStreamRequest(invalid)).toThrow(ValidationError);
        });

        it('should reject non-object request', () => {
            expect(() => validateCreateStreamRequest('not an object')).toThrow(ValidationError);
        });
    });

    describe('validateStreamId', () => {
        it('should accept valid stream ID', () => {
            const id = 'stream-1234567890';
            expect(validateStreamId(id)).toBe(id);
        });

        it('should reject invalid stream ID format', () => {
            expect(() => validateStreamId('invalid-id')).toThrow(ValidationError);
        });

        it('should reject empty stream ID', () => {
            expect(() => validateStreamId('')).toThrow(ValidationError);
        });
    });

    describe('validateJsonDepth', () => {
        it('should accept shallow objects', () => {
            const shallow = { a: 1, b: 2, c: 3 };
            expect(() => validateJsonDepth(shallow, 5)).not.toThrow();
        });

        it('should accept objects within depth limit', () => {
            const nested = { a: { b: { c: { d: 1 } } } };
            expect(() => validateJsonDepth(nested, 5)).not.toThrow();
        });

        it('should reject objects exceeding depth limit', () => {
            const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
            expect(() => validateJsonDepth(deep, 3)).toThrow(ValidationError);
        });

        it('should handle arrays in depth calculation', () => {
            const arrayNested = { a: [{ b: [{ c: 1 }] }] };
            expect(() => validateJsonDepth(arrayNested, 5)).not.toThrow();
        });

        it('should reject deeply nested arrays', () => {
            const deepArray = { a: [[[[[1]]]]] };
            expect(() => validateJsonDepth(deepArray, 3)).toThrow(ValidationError);
        });

        it('should handle null and undefined values', () => {
            const withNull = { a: null, b: undefined, c: 1 };
            expect(() => validateJsonDepth(withNull, 2)).not.toThrow();
        });

        it('should handle primitive values', () => {
            expect(() => validateJsonDepth(42, 1)).not.toThrow();
            expect(() => validateJsonDepth('string', 1)).not.toThrow();
            expect(() => validateJsonDepth(true, 1)).not.toThrow();
        });

        it('should reject at exact depth boundary', () => {
            const atBoundary = { a: { b: { c: 1 } } };
            expect(() => validateJsonDepth(atBoundary, 2)).toThrow(ValidationError);
        });
    });

    describe('validateRequestSize', () => {
        it('should accept request within size limit', () => {
            expect(() => validateRequestSize(1000, 10000)).not.toThrow();
        });

        it('should accept request at exact size limit', () => {
            expect(() => validateRequestSize(10000, 10000)).not.toThrow();
        });

        it('should reject request exceeding size limit', () => {
            expect(() => validateRequestSize(10001, 10000)).toThrow(ValidationError);
        });

        it('should reject large request', () => {
            expect(() => validateRequestSize(1024 * 1024 * 2, 1024 * 1024)).toThrow(ValidationError);
        });
    });
});
