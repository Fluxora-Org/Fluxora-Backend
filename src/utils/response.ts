/**
 * Consistent JSON envelope helpers for Fluxora Backend
 *
 * All success responses are wrapped in:
 *   { success: true, data: T, meta?: ResponseMeta }
 *
 * All error responses are wrapped in:
 *   { success: false, error: string, code: string, details?: string, field?: string }
 *
 * This contract is stable — clients and auditors may rely on it.
 */

export interface ResponseMeta {
    /** ISO-8601 timestamp of the response */
    timestamp: string;
    /** Opaque request identifier for log correlation */
    requestId?: string;
}

export interface SuccessEnvelope<T> {
    success: true;
    data: T;
    meta: ResponseMeta;
}

export interface ErrorEnvelope {
    success: false;
    error: string;
    code: string;
    details?: string;
    field?: string;
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
 * Build an error envelope.
 */
export function errorResponse(
    error: string,
    code: string,
    details?: string,
    field?: string
): ErrorEnvelope {
    return {
        success: false,
        error,
        code,
        ...(details !== undefined ? { details } : {}),
        ...(field !== undefined ? { field } : {}),
    };
}
