/**
 * Request protection middleware for Fluxora Backend
 *
 * Provides:
 * - Request size limit enforcement (Content-Length header + raw stream byte counting)
 * - JSON depth validation
 * - Request timeout protection
 *
 * Failure modes and client-visible behavior:
 * - Oversized request (413 Payload Too Large): Content-Length or streamed bytes exceed limit
 * - Excessive JSON depth (400 Bad Request): Nested objects exceed depth limit
 * - Request timeout (408 Request Timeout): Request processing exceeds timeout
 *
 * All error responses use the standard { success, error, code, details } envelope.
 */

import { Request, Response, NextFunction } from 'express';
import { Logger } from '../config/logger';
import { validateJsonDepth, ValidationError } from '../config/validation';
import { errorResponse } from '../utils/response';

/**
 * Custom error class for request protection violations
 */
export class RequestProtectionError extends Error {
    constructor(
        message: string,
        public statusCode: number,
        public code: string
    ) {
        super(message);
        this.name = 'RequestProtectionError';
    }
}

/**
 * Middleware to enforce request size limits.
 *
 * Two-layer enforcement:
 * 1. Content-Length header check (fast path — rejects before reading body)
 * 2. Raw stream byte counting (catches chunked/streaming requests without Content-Length)
 *
 * Must be applied BEFORE express.json() so the raw stream is still available.
 */
export function createRequestSizeLimitMiddleware(maxSizeBytes: number) {
    return (req: Request, res: Response, next: NextFunction) => {
        const logger = req.app.locals.logger as Logger;

        // Fast path: reject via Content-Length header
        const contentLength = req.get('content-length');
        if (contentLength) {
            const size = parseInt(contentLength, 10);
            if (size > maxSizeBytes) {
                logger.warn('Request rejected: payload too large (Content-Length)', {
                    contentLength: size,
                    maxSizeBytes,
                    path: req.path,
                    method: req.method,
                });
                return res.status(413).json(
                    errorResponse(
                        'Payload too large',
                        'PAYLOAD_TOO_LARGE',
                        `Request size (${size} bytes) exceeds maximum allowed (${maxSizeBytes} bytes)`
                    )
                );
            }
        }

        // Slow path: count raw stream bytes for chunked / no Content-Length requests
        let receivedBytes = 0;
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (!aborted && receivedBytes > maxSizeBytes) {
                aborted = true;
                logger.warn('Request rejected: payload too large (stream)', {
                    receivedBytes,
                    maxSizeBytes,
                    path: req.path,
                    method: req.method,
                });
                res.status(413).json(
                    errorResponse(
                        'Payload too large',
                        'PAYLOAD_TOO_LARGE',
                        `Streamed bytes (${receivedBytes}) exceed maximum allowed (${maxSizeBytes} bytes)`
                    )
                );
                req.socket.destroy();
            }
        });

        next();
    };
}

/**
 * Middleware to validate JSON depth after parsing.
 * Must be applied AFTER express.json().
 */
export function createJsonDepthValidationMiddleware(maxDepth: number) {
    return (req: Request, res: Response, next: NextFunction) => {
        const logger = req.app.locals.logger as Logger;

        // Only validate JSON requests with body
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
            try {
                validateJsonDepth(req.body, maxDepth, 'request body');
            } catch (err) {
                if (err instanceof ValidationError) {
                    logger.warn('Request rejected: JSON depth exceeded', {
                        maxDepth,
                        path: req.path,
                        method: req.method,
                        error: err.message,
                    });
                    return res.status(400).json(
                        errorResponse('Invalid request', 'JSON_DEPTH_EXCEEDED', err.message)
                    );
                }
                throw err;
            }
        }

        next();
    };
}

/**
 * Middleware to enforce request timeout.
 * Aborts request processing if it exceeds timeout.
 */
export function createRequestTimeoutMiddleware(timeoutMs: number) {
    return (req: Request, res: Response, next: NextFunction) => {
        const logger = req.app.locals.logger as Logger;

        req.socket.setTimeout(timeoutMs, () => {
            logger.warn('Request timeout', {
                timeoutMs,
                path: req.path,
                method: req.method,
                remoteAddr: req.ip,
            });

            if (!res.headersSent) {
                res.status(408).json(
                    errorResponse(
                        'Request timeout',
                        'REQUEST_TIMEOUT',
                        `Request processing exceeded ${timeoutMs}ms timeout`
                    )
                );
            }

            req.socket.destroy();
        });

        res.on('finish', () => {
            req.socket.setTimeout(0);
        });

        next();
    };
}

/**
 * Error handler for RequestProtectionError instances.
 * Should be registered after all other middleware.
 */
export function requestProtectionErrorHandler(
    err: any,
    _req: Request,
    res: Response,
    next: NextFunction
) {
    if (err instanceof RequestProtectionError) {
        return res.status(err.statusCode).json(
            errorResponse(err.message, err.code)
        );
    }

    next(err);
}
