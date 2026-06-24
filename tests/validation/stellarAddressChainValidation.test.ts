/**
 * Tests for src/validation/stellarAddressValidator.ts
 *
 * Covers:
 *  - Both addresses exist → valid: true
 *  - Sender missing → valid: false, missingAddresses includes sender
 *  - Recipient missing → valid: false, missingAddresses includes recipient
 *  - Both missing → valid: false, both in missingAddresses
 *  - Redis cache hit → RPC not called
 *  - Redis cache miss → RPC called, result cached
 *  - Negative result (404) not cached
 *  - Circuit breaker OPEN → fail-open (valid: true), warning logged
 *  - Generic RPC error → fail-open (valid: true), warning logged
 *  - Redis get failure → falls through to RPC
 *  - Redis set failure → non-fatal, result still returned
 *  - null Redis client → no cache, RPC always called
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StellarAddressValidator,
  STELLAR_ACCOUNT_CACHE_PREFIX,
} from '../../src/validation/stellarAddressValidator.js';
import { CircuitOpenError, RpcProviderError } from '../../src/services/stellar-rpc.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SENDER    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const RECIPIENT = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN';
const TTL = 300;

function makeRpc(responses: Record<string, boolean | Error>) {
  return {
    accountExists: vi.fn(async (address: string) => {
      const r = responses[address];
      if (r instanceof Error) throw r;
      return r ?? false;
    }),
  } as unknown as import('../../src/services/stellar-rpc.js').StellarRpcService;
}

// ── Core validation logic ─────────────────────────────────────────────────────

describe('StellarAddressValidator', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
  });

  it('returns valid:true when both addresses exist', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    expect(await v.validate(SENDER, RECIPIENT)).toEqual({ valid: true });
  });

  it('returns valid:false with sender in missingAddresses when sender absent', async () => {
    const rpc = makeRpc({ [SENDER]: false, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(SENDER);
    expect(result.missingAddresses).not.toContain(RECIPIENT);
  });

  it('returns valid:false with recipient in missingAddresses when recipient absent', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: false });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(RECIPIENT);
    expect(result.missingAddresses).not.toContain(SENDER);
  });

  it('includes both addresses when both are absent', async () => {
    const rpc = makeRpc({ [SENDER]: false, [RECIPIENT]: false });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toHaveLength(2);
  });

  // ── Redis cache ─────────────────────────────────────────────────────────────

  it('skips RPC when both addresses are cached', async () => {
    const rpc = makeRpc({});
    await redis.set(`${STELLAR_ACCOUNT_CACHE_PREFIX}${SENDER}`, '1');
    await redis.set(`${STELLAR_ACCOUNT_CACHE_PREFIX}${RECIPIENT}`, '1');
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(rpc.accountExists).not.toHaveBeenCalled();
  });

  it('calls RPC on cache miss and caches a positive result', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    await v.validate(SENDER, RECIPIENT);
    // Both should now be cached
    expect(await redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${SENDER}`)).toBe('1');
    expect(await redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${RECIPIENT}`)).toBe('1');
  });

  it('does NOT cache a negative (404) result', async () => {
    const rpc = makeRpc({ [SENDER]: false, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    await v.validate(SENDER, RECIPIENT);
    expect(await redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${SENDER}`)).toBeNull();
  });

  it('forwards TTL to Redis set', async () => {
    const setSpy = vi.spyOn(redis, 'set');
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, 600);
    await v.validate(SENDER, RECIPIENT);
    expect(setSpy).toHaveBeenCalledWith(
      expect.stringContaining(SENDER),
      '1',
      { ex: 600 },
    );
  });

  it('falls through to RPC when Redis get throws', async () => {
    redis.throwOnNext('get');
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(rpc.accountExists).toHaveBeenCalled();
  });

  it('returns result and does not throw when Redis set fails', async () => {
    redis.throwOnNext('set');
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL);
    await expect(v.validate(SENDER, RECIPIENT)).resolves.toEqual({ valid: true });
  });

  it('works with null Redis client (no cache)', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, null, TTL);
    expect(await v.validate(SENDER, RECIPIENT)).toEqual({ valid: true });
    expect(rpc.accountExists).toHaveBeenCalledTimes(2);
  });

  // ── Graceful degradation ────────────────────────────────────────────────────

  it('fails-open and logs a warning when circuit breaker is OPEN', async () => {
    const rpc = makeRpc({ [SENDER]: new CircuitOpenError(), [RECIPIENT]: new CircuitOpenError() });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circuit breaker OPEN'),
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  it('fails-open and logs a warning on generic RPC error', async () => {
    const rpcErr = new RpcProviderError('connection refused', 'NETWORK');
    const rpc = makeRpc({ [SENDER]: rpcErr, [RECIPIENT]: rpcErr });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('RPC error'),
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  it('fails-open when only one address errors (other is valid)', async () => {
    // sender errors (fail-open → treated as null/pass), recipient exists
    const rpc = makeRpc({
      [SENDER]: new CircuitOpenError(),
      [RECIPIENT]: true,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    // null (fail-open) + true → both pass → valid
    expect(result.valid).toBe(true);
    vi.restoreAllMocks();
  });

  it('returns valid:false when one address errors and the other is confirmed absent', async () => {
    // sender errors (fail-open), recipient is confirmed absent (false)
    const rpc = makeRpc({
      [SENDER]: new CircuitOpenError(),
      [RECIPIENT]: false,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL);
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(RECIPIENT);
    vi.restoreAllMocks();
  });
});
