import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateNextRetryDelay, withJitteredRetry, type JitteredRetryOptions } from '../../src/lib/retry.js';

describe('Shared Retry Helper', () => {
  const defaultOptions: JitteredRetryOptions = {
    baseDelayMs: 100,
    maxDelayMs: 1000,
    maxAttempts: 3,
  };

  describe('calculateNextRetryDelay', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // Midpoint for deterministic testing
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns 0 when max attempts are reached', () => {
      expect(calculateNextRetryDelay(3, defaultOptions)).toBe(0);
      expect(calculateNextRetryDelay(4, defaultOptions)).toBe(0);
    });

    it('calculates stateless jittered delay correctly for attempt 0', () => {
      // base = 100, cap = 1000. exp = 100 * 2^0 = 100.
      // jitter = 100 + 0.5 * (100 - 100) = 100
      expect(calculateNextRetryDelay(0, defaultOptions)).toBe(100);
    });

    it('calculates stateless jittered delay correctly for attempt 1', () => {
      // base = 100, cap = 1000. exp = 100 * 2^1 = 200.
      // jitter = 100 + 0.5 * (200 - 100) = 150
      expect(calculateNextRetryDelay(1, defaultOptions)).toBe(150);
    });

    it('caps the delay at maxDelayMs', () => {
      // attempt 4 -> exp = 100 * 2^4 = 1600. cap = 1000.
      // jitter = 100 + 0.5 * (1000 - 100) = 550
      const opts = { ...defaultOptions, maxAttempts: 5 };
      expect(calculateNextRetryDelay(4, opts)).toBe(550);
    });
  });

  describe('calculateNextRetryDelay: jitter algorithms', () => {
    it('full jitter uses the injectable random fn and is reproducible for the same seed', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        maxAttempts: 10,
        jitterAlgorithm: 'full',
        random: () => 0.42,
      };
      // attempt 2: exponential = 1000 * 2^2 = 4000, capped = 4000, delay = 0.42 * 4000 = 1680
      expect(calculateNextRetryDelay(2, options)).toBe(1680);
      expect(calculateNextRetryDelay(2, options)).toBe(1680);
    });

    it('full jitter stays within [0, capped exponential backoff]', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        maxAttempts: 10,
        jitterAlgorithm: 'full',
      };
      // attempt 3: exponential = 1000 * 2^3 = 8000, capped = 8000
      for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = calculateNextRetryDelay(3, { ...options, random: () => seed });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(8000);
      }
    });

    it('decorrelated jitter uses the injectable random fn and previousDelayMs, and is reproducible', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        maxAttempts: 10,
        jitterAlgorithm: 'decorrelated',
        previousDelayMs: 4000,
        random: () => 0.5,
      };
      // maxJitter = min(60000, 4000*3) = 12000, range = 11000, delay = 1000 + 0.5*11000 = 6500
      expect(calculateNextRetryDelay(4, options)).toBe(6500);
      expect(calculateNextRetryDelay(4, options)).toBe(6500);
    });

    it('decorrelated jitter is capped at maxDelayMs regardless of previousDelayMs', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        maxAttempts: 10,
        jitterAlgorithm: 'decorrelated',
        previousDelayMs: 100000,
        random: () => 1,
      };
      expect(calculateNextRetryDelay(1, options)).toBe(10000);
    });

    it('legacy algorithm with an injectable random fn matches the bounded-jitter formula', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        maxAttempts: 10,
        jitterAlgorithm: 'legacy',
        jitterPercent: 20,
        random: () => 0.5,
      };
      // attempt 2: exponential=4000, capped=4000, range=(4000-1000)*0.2=600, delay=1000+0.5*600=1300
      expect(calculateNextRetryDelay(2, options)).toBe(1300);
    });

    it('jitterPercent of 0 returns the deterministic capped exponential delay with no randomness', () => {
      const options: JitteredRetryOptions = {
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        maxAttempts: 10,
        jitterAlgorithm: 'full',
        jitterPercent: 0,
        random: () => {
          throw new Error('random should not be called when jitterPercent is 0');
        },
      };
      // attempt 3: exponential = capped = 8000
      expect(calculateNextRetryDelay(3, options)).toBe(8000);
    });

    it('falls back to Math.random when no injectable random fn is provided', () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.25);
      try {
        const options: JitteredRetryOptions = {
          baseDelayMs: 1000,
          maxDelayMs: 60000,
          maxAttempts: 10,
          jitterAlgorithm: 'full',
        };
        // attempt 1: exponential=2000, capped=2000, delay=0.25*2000=500
        expect(calculateNextRetryDelay(1, options)).toBe(500);
        expect(randomSpy).toHaveBeenCalled();
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe('withJitteredRetry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('returns the result immediately on success', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const result = await withJitteredRetry(operation, defaultOptions);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledWith(1);
    });

    it('retries until success and respects max attempts', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce('success on 3');

      const promise = withJitteredRetry(operation, defaultOptions);
      
      // Attempt 1 fails, sleeps: prev=0 -> maxJitter=300 -> nextDelay=100 + 0.5*(300-100)=200
      await vi.advanceTimersByTimeAsync(200);
      
      // Attempt 2 fails, sleeps: prev=200 -> maxJitter=600 -> nextDelay=100 + 0.5*(600-100)=350
      await vi.advanceTimersByTimeAsync(350);
      
      const result = await promise;
      
      expect(result).toBe('success on 3');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('throws error if max attempts are exceeded', async () => {
      const error = new Error('permanent fail');
      const operation = vi.fn().mockRejectedValue(error);

      const promise = withJitteredRetry(operation, defaultOptions);
      
      // 1st sleep: 200ms
      await vi.advanceTimersByTimeAsync(200);
      // 2nd sleep: 350ms
      await vi.advanceTimersByTimeAsync(350);
      // Attempt 3 fails, should throw because maxAttempts = 3.

      await expect(promise).rejects.toThrow(error);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('does not retry if isRetryable returns false', async () => {
      const error = new Error('fatal');
      const operation = vi.fn().mockRejectedValue(error);
      const isRetryable = vi.fn().mockReturnValue(false);

      await expect(withJitteredRetry(operation, defaultOptions, isRetryable)).rejects.toThrow(error);
      
      expect(operation).toHaveBeenCalledTimes(1);
      expect(isRetryable).toHaveBeenCalledWith(error);
    });
  });
});
