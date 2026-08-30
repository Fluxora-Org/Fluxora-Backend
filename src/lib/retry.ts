export interface JitteredRetryOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** Optional dynamic cap for a retry sleep, used to honour external deadlines. */
  maxDelayForAttemptMs?: () => number;
  /** Jitter algorithm to use. Defaults to 'legacy' (bounded jitter with baseDelayMs minimum). */
  jitterAlgorithm?: 'full' | 'decorrelated' | 'legacy';
  /** Jitter percentage (0-100). When 0, no jitter is applied (deterministic). Used only for 'legacy' algorithm. */
  jitterPercent?: number;
  /** Injectable random function for deterministic testing. Defaults to Math.random. */
  random?: () => number;
  /** Previous delay in ms, required for decorrelated jitter. */
  previousDelayMs?: number;
}

/**
 * Calculates a jittered delay based on the specified algorithm.
 *
 * Algorithms:
 * - 'full': Full jitter — random value in [0, capped_exponential_backoff].
 *           Recommended for avoiding synchronized retry storms. Uses 100% range.
 * - 'decorrelated': Decorrelated jitter — random value in [baseDelayMs, min(maxDelayMs, previousDelayMs * 3)].
 *                   Uses 100% range. Requires previousDelayMs for attempts > 0.
 * - 'legacy': Bounded jitter (default) — random value in [baseDelayMs, baseDelayMs + (capped - baseDelayMs) * jitterPercent/100].
 *             Uses jitterPercent (default 10%). Ensures at least baseDelayMs delay.
 *
 * This provides a stateless calculation of delay based on attempt number.
 * Useful for outbox/durable retry systems where we don't store previous delay.
 */
export function calculateNextRetryDelay(
  attemptNumber: number,
  options: JitteredRetryOptions
): number {
  if (attemptNumber >= options.maxAttempts) return 0;

  const random = options.random ?? Math.random;
  const algorithm = options.jitterAlgorithm ?? 'legacy';
  // For legacy algorithm, default to 100% range to match original behavior.
  // For full/decorrelated, jitterPercent is ignored (always 100% range).
  const jitterPercent = options.jitterPercent ?? (algorithm === 'legacy' ? 100 : 10);

  // Exponential base: base * 2^attempt
  const exponential = options.baseDelayMs * Math.pow(2, attemptNumber);
  const capped = Math.min(options.maxDelayMs, exponential);

  // No jitter when jitterPercent is 0
  if (jitterPercent === 0) {
    return Math.round(capped);
  }

  let jitteredDelay: number;

  if (algorithm === 'full') {
    // Full jitter: random value in [0, capped] — always 100% range
    jitteredDelay = random() * capped;
  } else if (algorithm === 'decorrelated') {
    // Decorrelated jitter: random in [baseDelayMs, min(maxDelayMs, previousDelayMs * 3)] — always 100% range
    const previousDelay = options.previousDelayMs ?? options.baseDelayMs;
    const maxJitter = Math.min(options.maxDelayMs, previousDelay * 3);
    const range = maxJitter - options.baseDelayMs;
    jitteredDelay = options.baseDelayMs + random() * Math.max(0, range);
  } else {
    // Legacy bounded jitter: random in [baseDelayMs, baseDelayMs + (capped - baseDelayMs) * jitterPercent/100]
    const range = (capped - options.baseDelayMs) * (jitterPercent / 100);
    jitteredDelay = options.baseDelayMs + random() * Math.max(0, range);
  }

  return Math.max(0, Math.round(jitteredDelay));
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
      const boundedDelay = Math.max(0, Math.min(delay, options.maxDelayForAttemptMs?.() ?? delay));
      await new Promise((resolve) => setTimeout(resolve, boundedDelay));
    }
  }
}