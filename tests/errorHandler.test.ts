/**
 * Tests for error handler middleware with RPC error support
 */

import { Request, Response, NextFunction } from 'express';
import {
  errorHandler,
  ApiErrorCode,
  ApiErrorResponse,
} from '../src/middleware/errorHandler.js';
import {
  RpcError,
  RpcTimeoutError,
  RpcCircuitOpenError,
  RpcRetryExhaustedError,
  RpcValidationError,
} from '../src/stellar/errors.js';

describe('errorHandler - RPC Error Handling', () => {
  let mockRequest: Partial<Request & { id?: string }>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonSpy: jest.Mock;
  let statusSpy: jest.Mock;

  beforeEach(() => {
    jsonSpy = jest.fn();
    statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });

    mockRequest = {
      id: 'test-request-id',
    };

    mockResponse = {
      status: statusSpy,
    } as Partial<Response>;

    mockNext = jest.fn();
  });

  describe('RpcTimeoutError handling', () => {
    it('should map RpcTimeoutError to 504 Gateway Timeout', () => {
      const error = new RpcTimeoutError(
        'Request timed out after 5000ms',
        'test-correlation-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(504);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: ApiErrorCode.GATEWAY_TIMEOUT,
            message: 'Request timed out after 5000ms',
            details: expect.objectContaining({
              rpcErrorCode: 'RPC_TIMEOUT',
              correlationId: 'test-correlation-id',
            }),
            requestId: 'test-request-id',
            correlationId: 'test-correlation-id',
          }),
        })
      );
    });

    it('should preserve correlation ID from RPC error', () => {
      const correlationId = 'correlation-123';
      const error = new RpcTimeoutError('Timeout', correlationId);

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
      expect(response.error.correlationId).toBe(correlationId);
      expect(response.error.details).toMatchObject({
        correlationId,
      });
    });
  });

  describe('RpcCircuitOpenError handling', () => {
    it('should map RpcCircuitOpenError to 503 Service Unavailable', () => {
      const error = new RpcCircuitOpenError(
        'Circuit breaker is open',
        'test-correlation-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(503);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: ApiErrorCode.SERVICE_UNAVAILABLE,
            message: 'Circuit breaker is open',
            details: expect.objectContaining({
              rpcErrorCode: 'RPC_CIRCUIT_OPEN',
              correlationId: 'test-correlation-id',
            }),
          }),
        })
      );
    });
  });

  describe('RpcRetryExhaustedError handling', () => {
    it('should map RpcRetryExhaustedError to 503 Service Unavailable', () => {
      const lastError = new Error('Connection refused');
      const error = new RpcRetryExhaustedError(
        'Retry attempts exhausted',
        3,
        lastError,
        [],
        'test-correlation-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(503);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: ApiErrorCode.SERVICE_UNAVAILABLE,
            message: 'Retry attempts exhausted',
            details: expect.objectContaining({
              rpcErrorCode: 'RPC_RETRY_EXHAUSTED',
              attempts: 3,
              correlationId: 'test-correlation-id',
            }),
          }),
        })
      );
    });

    it('should include attempt count in error details', () => {
      const error = new RpcRetryExhaustedError(
        'Failed after retries',
        5,
        new Error('Last error'),
        [],
        'corr-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
      expect(response.error.details).toMatchObject({
        attempts: 5,
      });
    });
  });

  describe('RpcValidationError handling', () => {
    it('should map RpcValidationError to 400 Bad Request', () => {
      const error = new RpcValidationError(
        'Invalid account ID format',
        'accountId',
        'test-correlation-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: ApiErrorCode.VALIDATION_ERROR,
            message: 'Invalid account ID format',
            details: expect.objectContaining({
              rpcErrorCode: 'RPC_VALIDATION_ERROR',
              field: 'accountId',
              correlationId: 'test-correlation-id',
            }),
          }),
        })
      );
    });

    it('should include field name in error details', () => {
      const error = new RpcValidationError(
        'Invalid field',
        'transactionHash',
        'corr-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
      expect(response.error.details).toMatchObject({
        field: 'transactionHash',
      });
    });
  });

  describe('Generic RpcError handling', () => {
    it('should map generic RpcError to 502 Bad Gateway', () => {
      const error = new RpcError(
        'RPC node returned invalid response',
        'RPC_INVALID_RESPONSE',
        undefined,
        'test-correlation-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(502);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: ApiErrorCode.BAD_GATEWAY,
            message: 'RPC node returned invalid response',
            details: expect.objectContaining({
              rpcErrorCode: 'RPC_INVALID_RESPONSE',
              correlationId: 'test-correlation-id',
            }),
          }),
        })
      );
    });

    it('should include RPC error code in details', () => {
      const error = new RpcError(
        'Custom RPC error',
        'CUSTOM_ERROR_CODE',
        undefined,
        'corr-id'
      );

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
      expect(response.error.details).toMatchObject({
        rpcErrorCode: 'CUSTOM_ERROR_CODE',
      });
    });
  });

  describe('Correlation ID preservation', () => {
    it('should preserve correlation ID in response for all RPC errors', () => {
      const correlationId = 'unique-correlation-id';
      const errors = [
        new RpcTimeoutError('Timeout', correlationId),
        new RpcCircuitOpenError('Circuit open', correlationId),
        new RpcRetryExhaustedError('Exhausted', 3, new Error(), [], correlationId),
        new RpcValidationError('Invalid', 'field', correlationId),
        new RpcError('Generic', 'CODE', undefined, correlationId),
      ];

      errors.forEach((error) => {
        jsonSpy.mockClear();
        statusSpy.mockClear();

        errorHandler(
          error,
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
        expect(response.error.correlationId).toBe(correlationId);
        expect(response.error.details).toMatchObject({
          correlationId,
        });
      });
    });
  });

  describe('Request ID inclusion', () => {
    it('should include request ID in all RPC error responses', () => {
      const error = new RpcTimeoutError('Timeout', 'corr-id');

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
      expect(response.error.requestId).toBe('test-request-id');
    });

    it('should handle missing request ID gracefully', () => {
      const error = new RpcTimeoutError('Timeout', 'corr-id');
      mockRequest.id = undefined;

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const response = jsonSpy.mock.calls[0][0] as ApiErrorResponse;
      expect(response.error.requestId).toBeUndefined();
    });
  });
});
