export interface JitteredRetryOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/**
 * Calculates a jittered delay based on an approximation of Decorrelated Jitter.
 * 
 * This provides a stateless calculation of delay based on attempt number.
 * Useful for outbox/durable retry systems where we don't store previous delay.
 */
export function calculateNextRetryDelay(
  attemptNumber: number,
  options: JitteredRetryOptions
): number {
  if (attemptNumber >= options.maxAttempts) return 0;
  
  // Exponential base: base * 2^attempt
  const exponential = options.baseDelayMs * Math.pow(2, attemptNumber);
  const capped = Math.min(options.maxDelayMs, exponential);
  
  // Ensures we always wait at least baseDelayMs but randomized up to cap
  const jitter = options.baseDelayMs + Math.random() * (capped - options.baseDelayMs);
  return Math.max(0, Math.round(jitter));
}

/**
 * Executes a promise-returning operation with retry and decorrelated jitter.
 */
export async function withJitteredRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: JitteredRetryOptions,
  isRetryable: (error: unknown) => boolean = () => true
): Promise<T> {
  let attempt = 0;
  let previousDelayMs = 0;

  while (true) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      attempt++;
      if (attempt >= options.maxAttempts || !isRetryable(error)) {
        throw error;
      }

      // True decorrelated jitter for async loop: sleep = min(cap, random_between(base, sleep * 3))
      const maxJitter = previousDelayMs === 0 ? options.baseDelayMs * 3 : previousDelayMs * 3;
      const nextDelay = options.baseDelayMs + Math.random() * (Math.max(options.baseDelayMs, maxJitter) - options.baseDelayMs);
      const delay = Math.round(Math.min(options.maxDelayMs, nextDelay));
      
      previousDelayMs = delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
