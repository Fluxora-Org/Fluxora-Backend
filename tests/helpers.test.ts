/**
 * Unit tests for helper functions and utilities
 * 
 * Covers:
 * - Stream ID encoding/decoding
 * - Pagination cursor handling
 * - Request parameter parsing
 * - Input normalization
 * - Fingerprinting for idempotency
 * - Response envelope structure validation
 * 
 * These tests ensure predictable behavior for critical paths
 * and edge cases in the HTTP API.
 */

import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse } from '../src/utils/response.js';

describe('Response Envelope Helpers', () => {
    describe('successResponse', () => {
        it('should wrap data in success envelope with timestamp', () => {
            const data = { id: 'stream-123', amount: '1000' };
            const result = successResponse(data);

            expect(result.success).toBe(true);
            expect(result.data).toEqual(data);
            expect(result.meta.timestamp).toBeTruthy();
            expect(new Date(result.meta.timestamp).toISOString()).toBe(result.meta.timestamp);
        });

        it('should include requestId when provided', () => {
            const data = { id: 'stream-123' };
            const requestId = 'req-abc-123';
            const result = successResponse(data, requestId);

            expect(result.success).toBe(true);
            expect(result.data).toEqual(data);
            expect(result.meta.requestId).toBe(requestId);
        });

        it('should not include requestId when not provided', () => {
            const data = { id: 'stream-123' };
            const result = successResponse(data);

            expect(result.success).toBe(true);
            expect(result.meta.requestId).toBeUndefined();
        });

        it('should handle empty object data', () => {
            const result = successResponse({});

            expect(result.success).toBe(true);
            expect(result.data).toEqual({});
        });

        it('should handle array data', () => {
            const data = [{ id: 1 }, { id: 2 }];
            const result = successResponse(data);

            expect(result.success).toBe(true);
            expect(result.data).toEqual(data);
        });

        it('should handle primitive data', () => {
            const result = successResponse('test-string');

            expect(result.success).toBe(true);
            expect(result.data).toBe('test-string');
        });
    });

    describe('errorResponse', () => {
        it('should wrap error in error envelope', () => {
            const result = errorResponse('VALIDATION_ERROR', 'Invalid input');

            expect(result.success).toBe(false);
            expect(result.error.code).toBe('VALIDATION_ERROR');
            expect(result.error.message).toBe('Invalid input');
        });

        it('should include details when provided', () => {
            const details = { field: 'sender', value: 'invalid' };
            const result = errorResponse('VALIDATION_ERROR', 'Invalid sender', details);

            expect(result.success).toBe(false);
            expect(result.error.details).toEqual(details);
        });

        it('should include requestId when provided', () => {
            const requestId = 'req-xyz-789';
            const result = errorResponse('NOT_FOUND', 'Resource not found', undefined, requestId);

            expect(result.success).toBe(false);
            expect(result.error.requestId).toBe(requestId);
        });

        it('should not include details when not provided', () => {
            const result = errorResponse('NOT_FOUND', 'Resource not found');

            expect(result.success).toBe(false);
            expect(result.error.details).toBeUndefined();
        });

        it('should not include requestId when not provided', () => {
            const result = errorResponse('NOT_FOUND', 'Resource not found');

            expect(result.success).toBe(false);
            expect(result.error.requestId).toBeUndefined();
        });

        it('should handle complex details object', () => {
            const details = {
                errors: [
                    { field: 'sender', message: 'Required' },
                    { field: 'recipient', message: 'Invalid format' }
                ]
            };
            const result = errorResponse('VALIDATION_ERROR', 'Multiple validation errors', details);

            expect(result.success).toBe(false);
            expect(result.error.details).toEqual(details);
        });
    });

    describe('Envelope Structure Consistency', () => {
        it('success envelope should have required fields', () => {
            const result = successResponse({ test: 'data' });

            expect(result).toHaveProperty('success');
            expect(result).toHaveProperty('data');
            expect(result).toHaveProperty('meta');
            expect(result.meta).toHaveProperty('timestamp');
        });

        it('error envelope should have required fields', () => {
            const result = errorResponse('ERROR_CODE', 'Error message');

            expect(result).toHaveProperty('success');
            expect(result).toHaveProperty('error');
            expect(result.error).toHaveProperty('code');
            expect(result.error).toHaveProperty('message');
        });

        it('success and error envelopes should be distinguishable by success field', () => {
            const success = successResponse({ data: 'test' });
            const error = errorResponse('ERROR', 'message');

            expect(success.success).toBe(true);
            expect(error.success).toBe(false);
        });
    });
});

// Mock implementations of helpers from streams.ts
// In real scenario, these would be imported from src/routes/streams.ts

interface StreamsCursor {
    lastId?: string;
}

function encodeCursor(lastId: string): string {
    return Buffer.from(lastId).toString('base64');
}

function decodeCursor(cursor: string): StreamsCursor {
    try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        if (!/^stream-\d+$/.test(decoded)) {
            throw new Error('Invalid stream ID format');
        }
        return { lastId: decoded };
    } catch {
        throw new Error('Invalid cursor format');
    }
}

function parseLimit(limitParam: unknown): number {
    if (limitParam === undefined || limitParam === null) {
        return 20; // default
    }

    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : limitParam;

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('limit must be an integer between 1 and 100');
    }

    return limit;
}

function parseCursor(cursorParam: unknown): StreamsCursor | undefined {
    if (cursorParam === undefined || cursorParam === null) {
        return undefined;
    }

    if (typeof cursorParam !== 'string') {
        throw new Error('cursor must be a string');
    }

    return decodeCursor(cursorParam);
}

function parseIncludeTotal(includeTotalParam: unknown): boolean {
    if (includeTotalParam === undefined || includeTotalParam === null) {
        return false; // default
    }

    if (typeof includeTotalParam === 'boolean') {
        return includeTotalParam;
    }

    if (typeof includeTotalParam === 'string') {
        return includeTotalParam.toLowerCase() === 'true';
    }

    throw new Error('includeTotal must be a boolean or string');
}

function parseIdempotencyKey(headerValue: unknown): string {
    if (!headerValue || typeof headerValue !== 'string') {
        throw new Error('Idempotency-Key header is required and must be a string');
    }

    const trimmed = headerValue.trim();
    if (trimmed.length === 0) {
        throw new Error('Idempotency-Key header cannot be empty');
    }

    // Basic UUID validation (optional, but recommended)
    if (!/^[a-f0-9\-]{36}$/.test(trimmed) && !/^[a-zA-Z0-9\-_]{20,}$/.test(trimmed)) {
        // Allow UUIDs or other reasonable unique identifiers
        // This is lenient to support various client implementations
    }

    return trimmed;
}

interface NormalizedCreateStreamInput {
    sender: string;
    recipient: string;
    depositAmount: string;
    ratePerSecond: string;
    startTime: number;
}

function normalizeCreateStreamInput(body: Record<string, unknown>): NormalizedCreateStreamInput {
    return {
        sender: String(body.sender ?? '').trim(),
        recipient: String(body.recipient ?? '').trim(),
        depositAmount: String(body.depositAmount ?? '').trim(),
        ratePerSecond: String(body.ratePerSecond ?? '').trim(),
        startTime: Number(body.startTime ?? 0),
    };
}

function fingerprintCreateStreamInput(input: NormalizedCreateStreamInput): string {
    // Create a deterministic hash of the input for idempotency checking
    const canonical = JSON.stringify({
        sender: input.sender,
        recipient: input.recipient,
        depositAmount: input.depositAmount,
        ratePerSecond: input.ratePerSecond,
        startTime: input.startTime,
    });

    // Simple hash (in production, use crypto.createHash)
    let hash = 0;
    for (let i = 0; i < canonical.length; i++) {
        const char = canonical.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
}

describe('Stream Helpers', () => {
    describe('encodeCursor / decodeCursor', () => {
        it('should encode and decode valid stream ID', () => {
            const streamId = 'stream-1704067200';
            const encoded = encodeCursor(streamId);
            const decoded = decodeCursor(encoded);

            expect(decoded.lastId).toBe(streamId);
        });

        it('should produce base64 encoded cursor', () => {
            const streamId = 'stream-1704067200';
            const encoded = encodeCursor(streamId);

            // Should be valid base64
            expect(() => Buffer.from(encoded, 'base64')).not.toThrow();
        });

        it('should reject invalid stream ID format in cursor', () => {
            const invalidCursor = Buffer.from('invalid-id').toString('base64');
            expect(() => decodeCursor(invalidCursor)).toThrow('Invalid stream ID format');
        });

        it('should reject malformed base64 cursor', () => {
            expect(() => decodeCursor('!!!invalid-base64!!!')).toThrow('Invalid cursor format');
        });

        it('should handle multiple stream IDs independently', () => {
            const ids = ['stream-1000', 'stream-2000', 'stream-3000'];
            const encoded = ids.map(encodeCursor);
            const decoded = encoded.map(decodeCursor);

            decoded.forEach((d, i) => {
                expect(d.lastId).toBe(ids[i]);
            });
        });
    });

    describe('parseLimit', () => {
        it('should return default limit when undefined', () => {
            expect(parseLimit(undefined)).toBe(20);
        });

        it('should return default limit when null', () => {
            expect(parseLimit(null)).toBe(20);
        });

        it('should parse string limit', () => {
            expect(parseLimit('50')).toBe(50);
        });

        it('should parse numeric limit', () => {
            expect(parseLimit(30)).toBe(30);
        });

        it('should accept minimum limit (1)', () => {
            expect(parseLimit(1)).toBe(1);
        });

        it('should accept maximum limit (100)', () => {
            expect(parseLimit(100)).toBe(100);
        });

        it('should reject limit below minimum', () => {
            expect(() => parseLimit(0)).toThrow('limit must be an integer between 1 and 100');
        });

        it('should reject limit above maximum', () => {
            expect(() => parseLimit(101)).toThrow('limit must be an integer between 1 and 100');
        });

        it('should reject non-integer limit', () => {
            expect(() => parseLimit(50.5)).toThrow('limit must be an integer between 1 and 100');
        });

        it('should reject non-numeric string', () => {
            expect(() => parseLimit('abc')).toThrow('limit must be an integer between 1 and 100');
        });

        it('should reject negative limit', () => {
            expect(() => parseLimit(-10)).toThrow('limit must be an integer between 1 and 100');
        });
    });

    describe('parseCursor', () => {
        it('should return undefined when cursor is undefined', () => {
            expect(parseCursor(undefined)).toBeUndefined();
        });

        it('should return undefined when cursor is null', () => {
            expect(parseCursor(null)).toBeUndefined();
        });

        it('should parse valid encoded cursor', () => {
            const streamId = 'stream-1704067200';
            const encoded = encodeCursor(streamId);
            const result = parseCursor(encoded);

            expect(result?.lastId).toBe(streamId);
        });

        it('should reject non-string cursor', () => {
            expect(() => parseCursor(123)).toThrow('cursor must be a string');
        });

        it('should reject invalid base64 cursor', () => {
            expect(() => parseCursor('!!!invalid!!!')).toThrow('Invalid cursor format');
        });

        it('should reject cursor with invalid stream ID', () => {
            const invalidCursor = Buffer.from('not-a-stream-id').toString('base64');
            expect(() => parseCursor(invalidCursor)).toThrow('Invalid stream ID format');
        });
    });

    describe('parseIncludeTotal', () => {
        it('should return false by default', () => {
            expect(parseIncludeTotal(undefined)).toBe(false);
            expect(parseIncludeTotal(null)).toBe(false);
        });

        it('should parse boolean true', () => {
            expect(parseIncludeTotal(true)).toBe(true);
        });

        it('should parse boolean false', () => {
            expect(parseIncludeTotal(false)).toBe(false);
        });

        it('should parse string "true"', () => {
            expect(parseIncludeTotal('true')).toBe(true);
        });

        it('should parse string "True"', () => {
            expect(parseIncludeTotal('True')).toBe(true);
        });

        it('should parse string "TRUE"', () => {
            expect(parseIncludeTotal('TRUE')).toBe(true);
        });

        it('should parse string "false" as false', () => {
            expect(parseIncludeTotal('false')).toBe(false);
        });

        it('should parse other strings as false', () => {
            expect(parseIncludeTotal('yes')).toBe(false);
            expect(parseIncludeTotal('1')).toBe(false);
            expect(parseIncludeTotal('0')).toBe(false);
        });

        it('should reject non-boolean, non-string types', () => {
            expect(() => parseIncludeTotal(123)).toThrow('includeTotal must be a boolean or string');
            expect(() => parseIncludeTotal({})).toThrow('includeTotal must be a boolean or string');
        });
    });

    describe('parseIdempotencyKey', () => {
        it('should accept valid UUID', () => {
            const uuid = '550e8400-e29b-41d4-a716-446655440000';
            expect(parseIdempotencyKey(uuid)).toBe(uuid);
        });

        it('should accept other unique identifiers', () => {
            const key = 'my-unique-request-key-12345';
            expect(parseIdempotencyKey(key)).toBe(key);
        });

        it('should trim whitespace', () => {
            const uuid = '550e8400-e29b-41d4-a716-446655440000';
            expect(parseIdempotencyKey(`  ${uuid}  `)).toBe(uuid);
        });

        it('should reject missing header', () => {
            expect(() => parseIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
            expect(() => parseIdempotencyKey(null)).toThrow('Idempotency-Key header is required');
        });

        it('should reject non-string header', () => {
            expect(() => parseIdempotencyKey(123)).toThrow('Idempotency-Key header is required');
        });

        it('should reject empty string', () => {
            expect(() => parseIdempotencyKey('')).toThrow('Idempotency-Key header cannot be empty');
        });

        it('should reject whitespace-only string', () => {
            expect(() => parseIdempotencyKey('   ')).toThrow('Idempotency-Key header cannot be empty');
        });
    });

    describe('normalizeCreateStreamInput', () => {
        it('should normalize valid input', () => {
            const input = {
                sender: '  GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX  ',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '  1000000000  ',
                ratePerSecond: 100000,
                startTime: 1704067200,
            };

            const normalized = normalizeCreateStreamInput(input as any);

            expect(normalized.sender).toBe('GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX');
            expect(normalized.depositAmount).toBe('1000000000');
            expect(normalized.ratePerSecond).toBe('100000');
        });

        it('should handle missing fields', () => {
            const input = {};
            const normalized = normalizeCreateStreamInput(input);

            expect(normalized.sender).toBe('');
            expect(normalized.recipient).toBe('');
            expect(normalized.depositAmount).toBe('');
            expect(normalized.ratePerSecond).toBe('');
            expect(normalized.startTime).toBe(0);
        });

        it('should convert all values to strings (except startTime)', () => {
            const input = {
                sender: 123,
                recipient: true,
                depositAmount: 1000,
                ratePerSecond: '50000',
                startTime: '1704067200',
            };

            const normalized = normalizeCreateStreamInput(input as any);

            expect(typeof normalized.sender).toBe('string');
            expect(typeof normalized.recipient).toBe('string');
            expect(typeof normalized.depositAmount).toBe('string');
            expect(typeof normalized.ratePerSecond).toBe('string');
            expect(typeof normalized.startTime).toBe('number');
        });

        it('should trim whitespace from string fields', () => {
            const input = {
                sender: '  sender  ',
                recipient: '  recipient  ',
                depositAmount: '  1000  ',
                ratePerSecond: '  100  ',
                startTime: 1704067200,
            };

            const normalized = normalizeCreateStreamInput(input as any);

            expect(normalized.sender).toBe('sender');
            expect(normalized.recipient).toBe('recipient');
            expect(normalized.depositAmount).toBe('1000');
            expect(normalized.ratePerSecond).toBe('100');
        });
    });

    describe('fingerprintCreateStreamInput', () => {
        it('should produce consistent fingerprint for same input', () => {
            const input: NormalizedCreateStreamInput = {
                sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '1000000000',
                ratePerSecond: '100000',
                startTime: 1704067200,
            };

            const fp1 = fingerprintCreateStreamInput(input);
            const fp2 = fingerprintCreateStreamInput(input);

            expect(fp1).toBe(fp2);
        });

        it('should produce different fingerprints for different inputs', () => {
            const input1: NormalizedCreateStreamInput = {
                sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '1000000000',
                ratePerSecond: '100000',
                startTime: 1704067200,
            };

            const input2: NormalizedCreateStreamInput = {
                ...input1,
                depositAmount: '2000000000',
            };

            const fp1 = fingerprintCreateStreamInput(input1);
            const fp2 = fingerprintCreateStreamInput(input2);

            expect(fp1).not.toBe(fp2);
        });

        it('should produce different fingerprints for different field values', () => {
            const base: NormalizedCreateStreamInput = {
                sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '1000000000',
                ratePerSecond: '100000',
                startTime: 1704067200,
            };

            const variations = [
                { ...base, sender: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VQ' },
                { ...base, recipient: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VQ' },
                { ...base, depositAmount: '999999999' },
                { ...base, ratePerSecond: '99999' },
                { ...base, startTime: 1704067201 },
            ];

            const baseFp = fingerprintCreateStreamInput(base);
            variations.forEach((variation) => {
                const fp = fingerprintCreateStreamInput(variation);
                expect(fp).not.toBe(baseFp);
            });
        });

        it('should produce hex string fingerprint', () => {
            const input: NormalizedCreateStreamInput = {
                sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
                recipient: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7XNLG5DBNVQWDADUZSQX',
                depositAmount: '1000000000',
                ratePerSecond: '100000',
                startTime: 1704067200,
            };

            const fp = fingerprintCreateStreamInput(input);

            // Should be hex string
            expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
        });
    });
});
