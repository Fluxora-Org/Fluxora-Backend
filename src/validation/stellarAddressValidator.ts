/**
 * Stellar address chain-existence validator.
 *
 * Checks that both sender and recipient addresses exist on-chain via the
 * Horizon REST API before a stream row is written to the database.
 *
 * Redis cache
 * -----------
 * Positive lookups (account found) are cached under
 * `fluxora:stellar:account:<address>` with a configurable TTL (default 300 s).
 * Negative results are NOT cached — a non-existent account may be funded
 * between requests, and caching a miss would silently block valid streams.
 *
 * Graceful degradation
 * --------------------
 * If the circuit breaker is OPEN or the RPC call fails for any reason other
 * than a clean 404, the validator fails-open: it logs a warning and allows
 * the request through. This prevents an RPC outage from blocking all stream
 * creation. Operators should alert on circuit-open events separately.
 *
 * Security notes
 * --------------
 * - Addresses are URL-encoded before use in Horizon URLs (done in stellar-rpc.ts).
 * - Cache keys use the raw address (already constrained to [A-Z2-7]{56} by
 *   the Zod schema) so no additional sanitisation is needed.
 * - The cache stores only a boolean flag ('1'), never account data.
 *
 * @module validation/stellarAddressValidator
 */

import type { RedisClient } from '../redis/client.js';
import type { StellarRpcService } from '../services/stellar-rpc.js';
import { CircuitOpenError } from '../services/stellar-rpc.js';

export const STELLAR_ACCOUNT_CACHE_PREFIX = 'fluxora:stellar:account:';

export interface AddressValidationResult {
  valid: boolean;
  /** Populated when valid is false and the address was reachable but absent. */
  missingAddresses?: string[];
}

export class StellarAddressValidator {
  constructor(
    private readonly rpc: StellarRpcService,
    private readonly redis: RedisClient | null,
    private readonly cacheTtlSeconds: number,
  ) {}

  /**
   * Validate that both addresses exist on-chain.
   *
   * Returns { valid: false, missingAddresses } when one or both are absent.
   * Returns { valid: true } when both exist (or when the RPC is unavailable
   * and we fail-open).
   */
  async validate(sender: string, recipient: string): Promise<AddressValidationResult> {
    const [senderExists, recipientExists] = await Promise.all([
      this.checkAddress(sender),
      this.checkAddress(recipient),
    ]);

    const missing: string[] = [];
    if (senderExists === false) missing.push(sender);
    if (recipientExists === false) missing.push(recipient);

    if (missing.length > 0) {
      return { valid: false, missingAddresses: missing };
    }
    return { valid: true };
  }

  /**
   * Check a single address.
   * Returns true (exists), false (confirmed absent), or null (RPC unavailable
   * — caller should treat as pass-through).
   */
  private async checkAddress(address: string): Promise<boolean | null> {
    // 1. Cache hit?
    const cached = await this.getCached(address);
    if (cached === true) return true;

    // 2. RPC call
    try {
      const exists = await this.rpc.accountExists(address);
      if (exists) {
        await this.setCached(address);
      }
      return exists;
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        console.warn('[StellarAddressValidator] Circuit breaker OPEN — failing open for address check', {
          addressLength: address.length,
        });
        return null; // fail-open
      }
      // Network / provider error — fail-open with a warning
      console.warn('[StellarAddressValidator] RPC error — failing open for address check', {
        addressLength: address.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async getCached(address: string): Promise<boolean | null> {
    if (!this.redis) return null;
    try {
      const val = await this.redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${address}`);
      return val === '1' ? true : null;
    } catch {
      return null;
    }
  }

  private async setCached(address: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        `${STELLAR_ACCOUNT_CACHE_PREFIX}${address}`,
        '1',
        { ex: this.cacheTtlSeconds },
      );
    } catch {
      // Cache write failure is non-fatal
    }
  }
}
