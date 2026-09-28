import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateNextRetryDelay, withJitteredRetry, JitteredRetryOptions } from './retry';

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('calculateNextRetryDelay', () => {
    it('applies jitter by default (legacy algorithm)', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxAttempts: 5,
        random: () => 0.5,
      };

      // attempt 0 (exponential base: 100 * 2^0 = 100)
      // legacy bounded jitter: range = (100 - 100) * 1.0 = 0 -> delay = 100
      expect(calculateNextRetryDelay(0, options)).toBe(100);

      // attempt 1 (exponential base: 100 * 2^1 = 200)
      // legacy bounded jitter: range = (200 - 100) * 1.0 = 100 -> delay = 100 + 0.5 * 100 = 150
      expect(calculateNextRetryDelay(1, options)).toBe(150);

      // attempt 2 (exponential base: 100 * 2^2 = 400)
      // legacy bounded jitter: range = (400 - 100) * 1.0 = 300 -> delay = 100 + 0.5 * 300 = 250
      expect(calculateNextRetryDelay(2, options)).toBe(250);
    });

    it('enforces maximum delay', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 100,
        maxDelayMs: 500,
        maxAttempts: 10,
        random: () => 1.0, // Maximize jitter
      };

      // attempt 4 (exponential base: 100 * 2^4 = 1600) -> capped at 500
      // legacy bounded jitter: range = (500 - 100) * 1.0 = 400 -> delay = 100 + 1.0 * 400 = 500
      expect(calculateNextRetryDelay(4, options)).toBe(500);
      expect(calculateNextRetryDelay(5, options)).toBe(500);
    });

    it('enforces total attempt budget', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxAttempts: 3,
      };

      expect(calculateNextRetryDelay(3, options)).toBe(0);
      expect(calculateNextRetryDelay(4, options)).toBe(0);
    });
  });

  describe('withJitteredRetry', () => {
    it('distinguishes errors that must not be retried', async () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxAttempts: 5,
      };

      let attempts = 0;
      const operation = async (attempt: number) => {
        attempts++;
        throw new Error('FatalError');
      };

      const isRetryable = (error: any) => error.message !== 'FatalError';

      await expect(withJitteredRetry(operation, options, isRetryable)).rejects.toThrow('FatalError');
      expect(attempts).toBe(1); // Should only try once and fail immediately
    });

    it('asserts the delay distribution includes jitter (delays are spread)', async () => {
      // Create a scenario where many operations fail and retry at the same time
      const NUM_CONCURRENT = 100;
      const options: JitteredRetryOptions = {
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxAttempts: 3, // We will succeed on attempt 2
      };

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const operations = Array.from({ length: NUM_CONCURRENT }).map(() => {
        return withJitteredRetry(async (attempt) => {
          if (attempt === 1) {
            throw new Error('Transient Error');
          }
          return 'success';
        }, options);
      });

      // Let the first attempts fail and the retries be scheduled
      await Promise.resolve(); // Flush pending promises
      
      // All setTimeout should have been called for the retries. Let's inspect the delays.
      const delays = setTimeoutSpy.mock.calls.map(call => call[1] as number);
      
      expect(delays.length).toBe(NUM_CONCURRENT);

      // Verify that not all delays are exactly the same (they should be spread out due to jitter)
      const uniqueDelays = new Set(delays);
      
      // We expect many unique delays because Math.random() is used, 
      // ensuring they don't synchronise in a thundering herd.
      // Even with some rounding, 100 concurrent requests should produce > 1 unique delay.
      expect(uniqueDelays.size).toBeGreaterThan(10);
      
      // Run the timers to complete the operations
      vi.runAllTimers();
      
      const results = await Promise.all(operations);
      expect(results).toEqual(Array(NUM_CONCURRENT).fill('success'));
    });
  });
});
