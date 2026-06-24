/**
 * Rate Limiting Service using Sliding Window counter.
 * Rate limit tracks requests per unique consumer URL within a defined window.
 *
 * @param store An object implementing a storage interface (e.g., WebhookDeliveryStore)
 * @param windowMs The duration of the sliding window in milliseconds.
 * @param limit The maximum number of requests allowed in the window.
 */
export class GlobalRateLimiter {
  constructor(private store: typeof WebhookDeliveryStore,
              private windowMs: number,
              private limit: number) {}

  /**
   * Checks if the delivery URL has exceeded the rate limit.
   * Updates the failure count atomically.
   * @param consumerUrl The unique URL identifying the consumer.
   * @returns true if the request is allowed, false if rate limited.
   */
  async canProceed(consumerUrl: string): Promise<boolean> {
    const currentTime = Date.now();
    const key = `rate_limit:${consumerUrl}`;

    // 1. Get existing count and last reset time for this consumer
    const cachedData = await this.store.getRateLimitData(key);

    let count = cachedData ? cachedData.count : 0;
    let windowStart = cachedData ? cachedData.windowStart : currentTime;

    // 2. Check if the window has expired.
    if (currentTime > windowStart + this.windowMs) {
      // Window expired, reset counter and start a new window.
      count = 1;
      windowStart = currentTime;
    } else {
      // Still within the window. Check against the limit.
      if (count >= this.limit) {
        return false; // Rate limited
      }
      count++;
    }

    // 3. Update the store with the new state
    await this.store.saveRateLimitData(key, count, windowStart);
    return true;
  }
}

// Simple interface for the rate limit data persisted in the store
export interface RateLimitData {
  count: number;
  windowStart: number;
}
