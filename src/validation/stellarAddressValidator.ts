// Pre-existing type error from upstream merge, unrelated to #1254; tracked under #TBD-typecheck-backlog.
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

import type { StellarNetwork } from '../config/stellar.js';
import type { RedisClient } from '../redis/client.js';
import type { StellarRpcService } from '../services/stellar-rpc.js';
import { CircuitOpenError } from '../services/stellar-rpc.js';
import {
  isValidStellarAccountAddress,
  networkLabel,
  STELLAR_ACCOUNT_CACHE_PREFIX,
} from './stellarAddress.js';

export { STELLAR_ACCOUNT_CACHE_PREFIX };
export { isValidStellarAccountAddress };

export interface AddressValidationResult {
  valid: boolean;
  /**
   * Populated when valid is false. Contains every address that failed, whether
   * because it is malformed (wrong type, bad checksum, case variant) or because
   * it does not exist on the configured network (wrong-network / absent).
   */
  missingAddresses?: string[];
  /**
   * Distinguishes why each rejected address failed. Keyed by the offending
   * address. `malformed` means it never reached an RPC call; `wrong-network`
   * means the address is a structurally valid account StrKey but was not found
   * on the configured network's ledger.
   */
  reasons?: Record<string, 'malformed' | 'wrong-network'>;
}

export class StellarAddressValidator {
  /**
   * @param rpc               Stellar RPC client, bound to the configured network.
   * @param redis             Optional Redis client for positive-lookup caching.
   * @param cacheTtlSeconds   TTL for cached positive lookups.
   * @param network           The configured Stellar network (source of truth for
   *                          what counts as a valid, on-network address).
   */
  constructor(
    private readonly rpc: StellarRpcService,
    private readonly redis: RedisClient | null,
    private readonly cacheTtlSeconds: number,
    private readonly network: StellarNetwork
  ) {}

  /**
   * Validate that both addresses exist on the configured network.
   *
   * Two layers of rejection:
   *   1. Format (synchronous, no RPC): malformed / wrong-type / case-variant /
   *      bad-checksum addresses are rejected before any network call.
   *   2. Network (asynchronous, on-chain): a structurally valid account StrKey
   *      that does not exist on the configured network is rejected as
   *      `wrong-network`.
   *
   * Returns { valid: false, missingAddresses, reasons } when any address fails.
   * Returns { valid: true } when both exist (or when the RPC is unavailable
   * and we fail-open — see {@link checkAddress}).
   */
  async validate(sender: string, recipient: string): Promise<AddressValidationResult> {
    const reasons: Record<string, 'malformed' | 'wrong-network'> = {};
    const malformed = [sender, recipient].filter((address) => {
      const ok = isValidStellarAccountAddress(address);
      if (!ok) reasons[address] = 'malformed';
      return !ok;
    });
    if (malformed.length > 0) {
      return { valid: false, missingAddresses: malformed, reasons };
    }

    const [senderExists, recipientExists] = await Promise.all([
      this.checkAddress(sender),
      this.checkAddress(recipient),
    ]);

    const missing: string[] = [];
    if (senderExists === false) {
      missing.push(sender);
      reasons[sender] = 'wrong-network';
    }
    if (recipientExists === false) {
      missing.push(recipient);
      reasons[recipient] = 'wrong-network';
    }

    if (missing.length > 0) {
      return { valid: false, missingAddresses: missing, reasons };
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
        console.warn(
          '[StellarAddressValidator] Circuit breaker OPEN — failing open for address check',
          {
            addressLength: address.length,
            network: networkLabel(this.network),
          }
        );
        return null; // fail-open
      }
      // Network / provider error — fail-open with a warning
      console.warn('[StellarAddressValidator] RPC error — failing open for address check', {
        addressLength: address.length,
        network: networkLabel(this.network),
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
      await this.redis.set(`${STELLAR_ACCOUNT_CACHE_PREFIX}${address}`, '1', {
        ex: this.cacheTtlSeconds,
      });
    } catch {
      // Cache write failure is non-fatal
    }
  }
}
