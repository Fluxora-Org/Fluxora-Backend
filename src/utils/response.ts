/**
 * Consistent JSON envelope helpers for Fluxora Backend
 *
 * All success responses are wrapped in:
 *   { success: true, data: T, meta: ResponseMeta }
 *
 * All error responses are wrapped in:
 *   { success: false, error: { code: string, message: string, details?: unknown, requestId?: string } }
 *
 * This contract is stable — clients and auditors may rely on it.
 */

export interface ResponseMeta {
    /** ISO-8601 timestamp of the response */
    timestamp: string;
    /** Opaque request identifier for log correlation */
    requestId?: string;
    /** Present on idempotent replays — true when the response was served from cache */
    idempotencyReplayed?: boolean;
}

export interface SuccessEnvelope<T> {
    success: true;
    data: T;
    meta: ResponseMeta;
}

export interface ErrorDetail {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
}

export interface ErrorEnvelope {
    success: false;
    error: ErrorDetail;
}

/**
 * Build a success envelope around any payload.
 */
export function successResponse<T>(data: T, requestId?: string): SuccessEnvelope<T> {
    return {
        success: true,
        data,
        meta: {
            timestamp: new Date().toISOString(),
            ...(requestId ? { requestId } : {}),
        },
    };
}

/**
 * Build a success envelope for an idempotent replay response.
 *
 * Identical to successResponse but stamps `meta.idempotencyReplayed = true`
 * so clients can distinguish a fresh creation from a cached replay without
 * inspecting the Idempotency-Replayed response header.
 */
export function idempotentReplayResponse<T>(data: T, requestId?: string): SuccessEnvelope<T> {
    return {
        success: true,
        data,
        meta: {
            timestamp: new Date().toISOString(),
            ...(requestId ? { requestId } : {}),
            idempotencyReplayed: true,
        },
    };
}

/**
 * Build an error envelope.
 */
export function errorResponse(
    code: string,
    message: string,
    details?: unknown,
    requestId?: string
): ErrorEnvelope {
    return {
        success: false,
        error: {
            code,
            message,
            ...(details !== undefined ? { details } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
        },
    };
}

/**
 * Runtime validator for the canonical error envelope shape.
 *
 * Intended for use in tests to assert that any JSON body emitted by a route
 * on an error path strictly matches the documented ErrorEnvelope contract.
 *
 * Usage:
 *   import { isErrorEnvelope } from '../utils/response.js';
 *   expect(isErrorEnvelope(body)).toBe(true);
 *
 * Returns true only when:
 *   - body.success === false
 *   - body.error is a non-null object
 *   - body.error.code is a non-empty string
 *   - body.error.message is a non-empty string
 *   - body.error.details (if present) may be any type
 *   - body.error.requestId (if present) is a string
 *   - no extra top-level keys beyond {success, error} are present
 */
export function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;

    // success must be exactly false
    if (b['success'] !== false) return false;

    // no extra top-level keys
    const topKeys = Object.keys(b);
    if (!topKeys.every((k) => k === 'success' || k === 'error')) return false;

    const err = b['error'];
    if (typeof err !== 'object' || err === null) return false;
    const e = err as Record<string, unknown>;

    if (typeof e['code'] !== 'string' || e['code'] === '') return false;
    if (typeof e['message'] !== 'string' || e['message'] === '') return false;
    if ('requestId' in e && typeof e['requestId'] !== 'string') return false;

    return true;
}
