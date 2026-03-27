import { describe, it, expect } from '@jest/globals';
import { successResponse, errorResponse } from './response';

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
            const result = errorResponse('Something went wrong', 'INTERNAL_ERROR');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Something went wrong');
            expect(result.code).toBe('INTERNAL_ERROR');
        });

        it('should include details when provided', () => {
            const result = errorResponse('Bad input', 'VALIDATION_ERROR', 'Field x is required');
            expect(result.details).toBe('Field x is required');
        });

        it('should omit details when not provided', () => {
            const result = errorResponse('Bad input', 'VALIDATION_ERROR');
            expect(result.details).toBeUndefined();
        });

        it('should include field when provided', () => {
            const result = errorResponse('Bad input', 'VALIDATION_ERROR', undefined, 'sender');
            expect(result.field).toBe('sender');
        });

        it('should omit field when not provided', () => {
            const result = errorResponse('Bad input', 'VALIDATION_ERROR');
            expect(result.field).toBeUndefined();
        });
    });
});
