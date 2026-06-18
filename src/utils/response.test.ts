import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse } from './response.js';

describe('Response envelope helpers', () => {
    describe('successResponse', () => {
        it('should wrap data in a success envelope', () => {
            const result = successResponse({ id: 1, name: 'test' });

            expect(result.success).toBe(true);
            expect(result.data).toEqual({ id: 1, name: 'test' });
            expect(result.meta).toBeDefined();
            expect(typeof result.meta.timestamp).toBe('string');
        });

        it('should include a valid ISO timestamp', () => {
            const result = successResponse({});
            expect(() => new Date(result.meta.timestamp)).not.toThrow();
            expect(new Date(result.meta.timestamp).toISOString()).toBe(result.meta.timestamp);
        });

        it('should include requestId when provided', () => {
            const result = successResponse({}, 'req-abc-123');
            expect(result.meta.requestId).toBe('req-abc-123');
        });

        it('should omit requestId when not provided', () => {
            const result = successResponse({});
            expect(result.meta.requestId).toBeUndefined();
        });

        it('should handle array data', () => {
            const result = successResponse([1, 2, 3]);
            expect(result.data).toEqual([1, 2, 3]);
        });

        it('should handle null data', () => {
            const result = successResponse(null);
            expect(result.data).toBeNull();
        });
    });

    describe('errorResponse', () => {
        it('should build an error envelope', () => {
            // Signature: errorResponse(code, message, details?, requestId?)
            const result = errorResponse('INTERNAL_ERROR', 'Something went wrong');

            expect(result.success).toBe(false);
            expect(result.error.code).toBe('INTERNAL_ERROR');
            expect(result.error.message).toBe('Something went wrong');
        });

        it('should include details when provided', () => {
            const result = errorResponse('VALIDATION_ERROR', 'Bad input', 'Field x is required');
            expect(result.error.details).toBe('Field x is required');
        });

        it('should omit details when not provided', () => {
            const result = errorResponse('VALIDATION_ERROR', 'Bad input');
            expect(result.error.details).toBeUndefined();
        });

        it('should include requestId when provided', () => {
            const result = errorResponse('VALIDATION_ERROR', 'Bad input', undefined, 'req-1');
            expect(result.error.requestId).toBe('req-1');
        });

        it('should omit requestId when not provided', () => {
            const result = errorResponse('VALIDATION_ERROR', 'Bad input');
            expect(result.error.requestId).toBeUndefined();
        });
    });
});
