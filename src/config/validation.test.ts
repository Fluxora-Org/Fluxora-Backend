import { describe, it, expect } from '@jest/globals';
import {
    ValidationError,
    validateStellarAddress,
    validateAmount,
    validateRatePerSecond,
    validateTimestamp,
    validateCreateStreamRequest,
    validateStreamId,
} from './validation';

describe('Validation Module', () => {
    describe('validateStellarAddress', () => {
        it('should accept valid Stellar address', () => {
            const address = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5YSXF3YFQHF';
            expect(validateStellarAddress(address)).toBe(address);
        });

        it('should reject empty address', () => {
            expect(() => validateStellarAddress('')).toThrow(ValidationError);
        });

        it('should reject non-string address', () => {
            expect(() => validateStellarAddress(null as any)).toThrow(ValidationError);
        });

        it('should reject address not starting with G', () => {
            expect(() => validateStellarAddress('ABRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5YSXF3YFQHF')).toThrow(
                ValidationError
            );
        });

        it('should reject address with wrong length', () => {
            expect(() => validateStellarAddress('GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5YSXF3YFQ')).toThrow(
                ValidationError
            );
        });

        it('should reject address with invalid characters', () => {
            expect(() => validateStellarAddress('GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5YSXF3YFQH!')).toThrow(
                ValidationError
            );
        });
    });

    describe('validateAmount', () => {
        it('should accept valid amount', () => {
            expect(validateAmount('1000000')).toBe('1000000');
        });

        it('should accept amount as number', () => {
            expect(validateAmount(1000000)).toBe('1000000');
        });

        it('should reject empty amount', () => {
            expect(() => validateAmount('')).toThrow(ValidationError);
        });

        it('should reject negative amount', () => {
            expect(() => validateAmount('-1000')).toThrow(ValidationError);
        });

        it('should reject zero amount', () => {
            expect(() => validateAmount('0')).toThrow(ValidationError);
        });

        it('should reject non-numeric amount', () => {
            expect(() => validateAmount('abc')).toThrow(ValidationError);
        });

        it('should reject amount exceeding Stellar max', () => {
            expect(() => validateAmount('9223372036854775808')).toThrow(ValidationError);
        });

        it('should accept amount at Stellar max', () => {
            expect(validateAmount('9223372036854775807')).toBe('9223372036854775807');
        });
    });

    describe('validateRatePerSecond', () => {
        it('should accept valid rate', () => {
            expect(validateRatePerSecond('1000')).toBe('1000');
        });

        it('should reject zero rate', () => {
            expect(() => validateRatePerSecond('0')).toThrow(ValidationError);
        });

        it('should reject negative rate', () => {
            expect(() => validateRatePerSecond('-100')).toThrow(ValidationError);
        });

        it('should reject non-numeric rate', () => {
            expect(() => validateRatePerSecond('abc')).toThrow(ValidationError);
        });
    });

    describe('validateTimestamp', () => {
        it('should accept future timestamp', () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(validateTimestamp(future)).toBe(future);
        });

        it('should accept recent timestamp', () => {
            const now = Math.floor(Date.now() / 1000);
            expect(validateTimestamp(now)).toBe(now);
        });

        it('should accept timestamp as string', () => {
            const future = Math.floor(Date.now() / 1000) + 3600;
            expect(validateTimestamp(String(future))).toBe(future);
        });

        it('should reject old timestamp', () => {
            const old = Math.floor(Date.now() / 1000) - 7200;
            expect(() => validateTimestamp(old)).toThrow(ValidationError);
        });

        it('should reject invalid timestamp', () => {
            expect(() => validateTimestamp('abc')).toThrow(ValidationError);
        });
    });

    describe('validateCreateStreamRequest', () => {
        const validRequest = {
            sender: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5YSXF3YFQHF',
            recipient: 'GBBD47UZQ5CYVVEUVRYNQZX3UYXF3YFQHFGBRPYHIL2CI3WHZDTOOQFC6',
            depositAmount: '1000000',
            ratePerSecond: '100',
            startTime: Math.floor(Date.now() / 1000) + 3600,
        };

        it('should accept valid request', () => {
            const result = validateCreateStreamRequest(validRequest);
            expect(result.sender).toBe(validRequest.sender);
            expect(result.recipient).toBe(validRequest.recipient);
        });

        it('should reject non-object request', () => {
            expect(() => validateCreateStreamRequest('not an object')).toThrow(ValidationError);
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

        it('should accept request with deposit equal to rate', () => {
            const valid = {
                ...validRequest,
                depositAmount: '100',
                ratePerSecond: '100',
            };
            const result = validateCreateStreamRequest(valid);
            expect(result.depositAmount).toBe('100');
        });
    });

    describe('validateStreamId', () => {
        it('should accept valid stream ID', () => {
            expect(validateStreamId('stream-1234567890')).toBe('stream-1234567890');
        });

        it('should reject empty ID', () => {
            expect(() => validateStreamId('')).toThrow(ValidationError);
        });

        it('should reject ID without stream- prefix', () => {
            expect(() => validateStreamId('1234567890')).toThrow(ValidationError);
        });

        it('should reject ID with non-numeric suffix', () => {
            expect(() => validateStreamId('stream-abc')).toThrow(ValidationError);
        });
    });
});
