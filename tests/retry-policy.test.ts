import { RetryPolicy } from '../src/stellar/retry-policy';
import { RpcError, RpcTimeoutError, RpcValidationError } from '../src/stellar/errors';

describe('RetryPolicy', () => {
  describe('shouldRetry', () => {
    it('should return false when max retries exceeded', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = new RpcError('Server error', 'SERVER_ERROR', 500);

      expect(policy.shouldRetry(3, error)).toBe(false);
      expect(policy.shouldRetry(4, error)).toBe(false);
    });

    it('should return true for transient HTTP errors within retry limit', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      
      // Test all transient status codes
      const transientCodes = [408, 429, 500, 502, 503, 504];
      transientCodes.forEach(code => {
        const error = new RpcError('Transient error', 'TRANSIENT', code);
        expect(policy.shouldRetry(0, error)).toBe(true);
        expect(policy.shouldRetry(2, error)).toBe(true);
      });
    });

    it('should return false for permanent HTTP errors', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      
      // Test all permanent status codes
      const permanentCodes = [400, 401, 403, 404, 405, 422];
      permanentCodes.forEach(code => {
        const error = new RpcError('Permanent error', 'PERMANENT', code);
        expect(policy.shouldRetry(0, error)).toBe(false);
      });
    });

    it('should return true for timeout errors', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = new RpcTimeoutError('Request timeout');

      expect(policy.shouldRetry(0, error)).toBe(true);
      expect(policy.shouldRetry(2, error)).toBe(true);
    });

    it('should return false for validation errors', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = new RpcValidationError('Invalid field', 'accountId');

      expect(policy.shouldRetry(0, error)).toBe(false);
    });

    it('should return true for network timeout errors (ETIMEDOUT)', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = Object.assign(new Error('Network timeout'), { code: 'ETIMEDOUT' });

      expect(policy.shouldRetry(0, error)).toBe(true);
    });

    it('should return true for connection refused errors (ECONNREFUSED)', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });

      expect(policy.shouldRetry(0, error)).toBe(true);
    });

    it('should return false for JSON parsing errors', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = new SyntaxError('Unexpected token in JSON at position 0');

      expect(policy.shouldRetry(0, error)).toBe(false);
    });

    it('should return false for unknown errors', () => {
      const policy = new RetryPolicy(3, 100, 5000);
      const error = new Error('Unknown error');

      expect(policy.shouldRetry(0, error)).toBe(false);
    });
  });

  describe('getBackoffDelay', () => {
    it('should calculate exponential backoff correctly', () => {
      const policy = new RetryPolicy(5, 100, 10000);

      // Attempt 0: 100 * 2^0 = 100
      const delay0 = policy.getBackoffDelay(0);
      expect(delay0).toBeGreaterThanOrEqual(100);
      expect(delay0).toBeLessThanOrEqual(120); // 100 + 20% jitter

      // Attempt 1: 100 * 2^1 = 200
      const delay1 = policy.getBackoffDelay(1);
      expect(delay1).toBeGreaterThanOrEqual(200);
      expect(delay1).toBeLessThanOrEqual(240); // 200 + 20% jitter

      // Attempt 2: 100 * 2^2 = 400
      const delay2 = policy.getBackoffDelay(2);
      expect(delay2).toBeGreaterThanOrEqual(400);
      expect(delay2).toBeLessThanOrEqual(480); // 400 + 20% jitter
    });

    it('should cap delay at maxBackoff', () => {
      const policy = new RetryPolicy(10, 100, 1000);

      // Attempt 10: 100 * 2^10 = 102400, but capped at 1000
      const delay = policy.getBackoffDelay(10);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1200); // 1000 + 20% jitter
    });

    it('should add jitter between 0 and 20% of base delay', () => {
      const policy = new RetryPolicy(5, 1000, 10000);
      
      // Run multiple times to verify jitter randomness
      const delays: number[] = [];
      for (let i = 0; i < 10; i++) {
        delays.push(policy.getBackoffDelay(0));
      }

      // All delays should be >= 1000 (base) and <= 1200 (base + 20%)
      delays.forEach(delay => {
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1200);
      });

      // At least some variation should exist (not all the same)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('should handle attempt 0 correctly', () => {
      const policy = new RetryPolicy(3, 500, 5000);

      const delay = policy.getBackoffDelay(0);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(600); // 500 + 20% jitter
    });

    it('should respect maxBackoff when exponential growth exceeds it', () => {
      const policy = new RetryPolicy(10, 100, 500);

      // Attempt 5: 100 * 2^5 = 3200, but capped at 500
      const delay = policy.getBackoffDelay(5);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(600); // 500 + 20% jitter
    });
  });
});
