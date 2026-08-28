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
import {
  classifyStellarAddress,
  isValidStellarAccountAddress,
} from '../../src/validation/stellarAddress.js';
import { CircuitOpenError, RpcProviderError } from '../../src/services/stellar-rpc.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import {
  CreateStreamSchema,
  StreamBatchCreateSchema,
} from '../../src/validation/schemas.js';
import { validateWebSocketMessage } from '../../src/ws/messageHandler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SENDER = 'GAAREIZUIVLGO6EJTKV3ZTO654ABCIRTIRKWM54ITGVLXTG5537RAI5F';
const RECIPIENT = 'GBNWY7MOT6YMDUXD6QCRMJZYJFNGW7ENT2X4BUPC6MCBKJRXJBMWUCQH';
const CONTRACT_ADDRESS = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';
const WRONG_NETWORK_ACCOUNT = 'GCV3ZTO654ABCIRTIRKWM54ITGVLXTG5537RAIJSINKGK5UHTCU3V7YT';
const MUXED_ADDRESS = 'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5IG';
const CASE_VARIANT_ADDRESS = 'gaareizuivlgo6ejtkv3zto654abcirtirkwm54itgvlxtg5537rai5f';
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

function mutateChecksum(address: string): string {
  const last = address[address.length - 1];
  return `${address.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
}

const MALFORMED_ACCOUNT_CASES = [
  {
    name: 'too short',
    address: SENDER.slice(0, -1),
  },
  {
    name: 'too long',
    address: `${SENDER}A`,
  },
  {
    name: 'invalid checksum',
    address: mutateChecksum(SENDER),
  },
  {
    name: 'wrong prefix',
    address: `S${SENDER.slice(1)}`,
  },
  {
    name: 'contract StrKey where account is expected',
    address: CONTRACT_ADDRESS,
  },
  {
    name: 'fullwidth G homoglyph',
    address: `Ｇ${SENDER.slice(1)}`,
  },
  {
    name: 'Greek Alpha homoglyph inside payload',
    address: `${SENDER.slice(0, 2)}Α${SENDER.slice(3)}`,
  },
] as const;

// ── Core validation logic ─────────────────────────────────────────────────────

describe('StellarAddressValidator', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
  });

  it('returns valid:true when both addresses exist', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    expect(await v.validate(SENDER, RECIPIENT)).toEqual({ valid: true });
  });

  it.each(MALFORMED_ACCOUNT_CASES)(
    'rejects malformed sender address before RPC: $name',
    async ({ address }) => {
      const rpc = {
        accountExists: vi.fn(async () => true),
      } as unknown as import('../../src/services/stellar-rpc.js').StellarRpcService;
      const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');

      const result = await v.validate(address, RECIPIENT);

      expect(result.valid).toBe(false);
      expect(result.missingAddresses).toContain(address);
      expect(rpc.accountExists).not.toHaveBeenCalledWith(address);
    }
  );

  it.each(MALFORMED_ACCOUNT_CASES)(
    'rejects malformed recipient address before RPC: $name',
    async ({ address }) => {
      const rpc = {
        accountExists: vi.fn(async () => true),
      } as unknown as import('../../src/services/stellar-rpc.js').StellarRpcService;
      const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');

      const result = await v.validate(SENDER, address);

      expect(result.valid).toBe(false);
      expect(result.missingAddresses).toContain(address);
      expect(rpc.accountExists).not.toHaveBeenCalledWith(address);
    }
  );

  it('rejects a valid account StrKey that does not exist on the configured chain', async () => {
    const rpc = makeRpc({ [SENDER]: true, [WRONG_NETWORK_ACCOUNT]: false });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');

    const result = await v.validate(SENDER, WRONG_NETWORK_ACCOUNT);

    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(WRONG_NETWORK_ACCOUNT);
    expect(result.reasons?.[WRONG_NETWORK_ACCOUNT]).toBe('wrong-network');
    expect(rpc.accountExists).toHaveBeenCalledWith(WRONG_NETWORK_ACCOUNT);
  });

  it('rejects a muxed (M…) address as malformed before any RPC call', async () => {
    const rpc = {
      accountExists: vi.fn(async () => true),
    } as unknown as import('../../src/services/stellar-rpc.js').StellarRpcService;
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');

    const result = await v.validate(MUXED_ADDRESS, RECIPIENT);

    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([MUXED_ADDRESS]);
    expect(result.reasons?.[MUXED_ADDRESS]).toBe('malformed');
    expect(rpc.accountExists).not.toHaveBeenCalledWith(MUXED_ADDRESS);
  });

  it('rejects a contract (C…) address supplied where an account is expected', async () => {
    const rpc = {
      accountExists: vi.fn(async () => true),
    } as unknown as import('../../src/services/stellar-rpc.js').StellarRpcService;
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');

    const result = await v.validate(SENDER, CONTRACT_ADDRESS);

    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([CONTRACT_ADDRESS]);
    expect(result.reasons?.[CONTRACT_ADDRESS]).toBe('malformed');
    expect(rpc.accountExists).not.toHaveBeenCalledWith(CONTRACT_ADDRESS);
  });

  it('rejects a lowercase / case-variant address as malformed', async () => {
    const rpc = {
      accountExists: vi.fn(async () => true),
    } as unknown as import('../../src/services/stellar-rpc.js').StellarRpcService;
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');

    const result = await v.validate(CASE_VARIANT_ADDRESS, RECIPIENT);

    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([CASE_VARIANT_ADDRESS]);
    expect(result.reasons?.[CASE_VARIANT_ADDRESS]).toBe('malformed');
    expect(rpc.accountExists).not.toHaveBeenCalledWith(CASE_VARIANT_ADDRESS);
  });

  it('returns valid:false with sender in missingAddresses when sender absent', async () => {
    const rpc = makeRpc({ [SENDER]: false, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(SENDER);
    expect(result.missingAddresses).not.toContain(RECIPIENT);
  });

  it('returns valid:false with recipient in missingAddresses when recipient absent', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: false });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(RECIPIENT);
    expect(result.missingAddresses).not.toContain(SENDER);
  });

  it('includes both addresses when both are absent', async () => {
    const rpc = makeRpc({ [SENDER]: false, [RECIPIENT]: false });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toHaveLength(2);
  });

  // ── Redis cache ─────────────────────────────────────────────────────────────

  it('skips RPC when both addresses are cached', async () => {
    const rpc = makeRpc({});
    await redis.set(`${STELLAR_ACCOUNT_CACHE_PREFIX}${SENDER}`, '1');
    await redis.set(`${STELLAR_ACCOUNT_CACHE_PREFIX}${RECIPIENT}`, '1');
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(rpc.accountExists).not.toHaveBeenCalled();
  });

  it('calls RPC on cache miss and caches a positive result', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    await v.validate(SENDER, RECIPIENT);
    // Both should now be cached
    expect(await redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${SENDER}`)).toBe('1');
    expect(await redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${RECIPIENT}`)).toBe('1');
  });

  it('does NOT cache a negative (404) result', async () => {
    const rpc = makeRpc({ [SENDER]: false, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    await v.validate(SENDER, RECIPIENT);
    expect(await redis.get(`${STELLAR_ACCOUNT_CACHE_PREFIX}${SENDER}`)).toBeNull();
  });

  it('forwards TTL to Redis set', async () => {
    const setSpy = vi.spyOn(redis, 'set');
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, 600, 'testnet');
    await v.validate(SENDER, RECIPIENT);
    expect(setSpy).toHaveBeenCalledWith(expect.stringContaining(SENDER), '1', { ex: 600 });
  });

  it('falls through to RPC when Redis get throws', async () => {
    redis.throwOnNext('get');
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(rpc.accountExists).toHaveBeenCalled();
  });

  it('returns result and does not throw when Redis set fails', async () => {
    redis.throwOnNext('set');
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    await expect(v.validate(SENDER, RECIPIENT)).resolves.toEqual({ valid: true });
  });

  it('works with null Redis client (no cache)', async () => {
    const rpc = makeRpc({ [SENDER]: true, [RECIPIENT]: true });
    const v = new StellarAddressValidator(rpc, null, TTL, 'testnet');
    expect(await v.validate(SENDER, RECIPIENT)).toEqual({ valid: true });
    expect(rpc.accountExists).toHaveBeenCalledTimes(2);
  });

  // ── Graceful degradation ────────────────────────────────────────────────────

  it('fails-open and logs a warning when circuit breaker is OPEN', async () => {
    const rpc = makeRpc({ [SENDER]: new CircuitOpenError(), [RECIPIENT]: new CircuitOpenError() });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circuit breaker OPEN'),
      expect.any(Object)
    );
    warnSpy.mockRestore();
  });

  it('fails-open and logs a warning on generic RPC error', async () => {
    const rpcErr = new RpcProviderError('connection refused', 'NETWORK');
    const rpc = makeRpc({ [SENDER]: rpcErr, [RECIPIENT]: rpcErr });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RPC error'), expect.any(Object));
    warnSpy.mockRestore();
  });

  it('fails-open when only one address errors (other is valid)', async () => {
    // sender errors (fail-open → treated as null/pass), recipient exists
    const rpc = makeRpc({
      [SENDER]: new CircuitOpenError(),
      [RECIPIENT]: true,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
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
    const v = new StellarAddressValidator(rpc, redis, TTL, 'testnet');
    const result = await v.validate(SENDER, RECIPIENT);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(RECIPIENT);
    vi.restoreAllMocks();
  });
});

// ── The single contract applied at every API boundary ────────────────────────
//
// The same shared validator must reject mixed-network / malformed input at the
// REST route, the indexer ingest path, and the WebSocket frame boundary.

describe('Network-aware contract at representative API boundaries', () => {
  it('REST route (POST /api/streams) rejects muxed and case-variant addresses', () => {
    const base = {
      depositAmount: '100',
      ratePerSecond: '1',
    };

    const muxed = CreateStreamSchema.safeParse({
      ...base,
      sender: MUXED_ADDRESS,
      recipient: RECIPIENT,
    });
    expect(muxed.success).toBe(false);

    const lower = CreateStreamSchema.safeParse({
      ...base,
      sender: CASE_VARIANT_ADDRESS,
      recipient: RECIPIENT,
    });
    expect(lower.success).toBe(false);

    const ok = CreateStreamSchema.safeParse({
      ...base,
      sender: SENDER,
      recipient: RECIPIENT,
    });
    expect(ok.success).toBe(true);
  });

  it('indexer batch ingest rejects a muxed sender address', () => {
    const batch = {
      streams: [
        {
          id: 'row-1',
          sender_address: MUXED_ADDRESS,
          recipient_address: RECIPIENT,
          amount: '100',
          streamed_amount: '0',
          remaining_amount: '100',
          rate_per_second: '1',
          start_time: 0,
          end_time: 1000,
          contract_id: CONTRACT_ADDRESS,
          transaction_hash: 'txhash',
          event_index: 0,
        },
      ],
    };

    const result = StreamBatchCreateSchema.safeParse(batch);
    expect(result.success).toBe(false);
  });

  it('WebSocket frame rejects muxed and case-variant recipient addresses', () => {
    const ok = validateWebSocketMessage(
      JSON.stringify({
        type: 'subscribe',
        recipient_address: RECIPIENT,
      })
    );
    expect(ok.ok).toBe(true);

    const muxed = validateWebSocketMessage(
      JSON.stringify({
        type: 'subscribe',
        recipient_address: MUXED_ADDRESS,
      })
    );
    expect(muxed.ok).toBe(false);

    const lower = validateWebSocketMessage(
      JSON.stringify({
        type: 'subscribe',
        recipient_address: CASE_VARIANT_ADDRESS,
      })
    );
    expect(lower.ok).toBe(false);
  });

  it('shared classify() reports account / muxed / contract / case-variant consistently', () => {
    expect(classifyStellarAddress(SENDER)).toMatchObject({ kind: 'account', valid: true });
    expect(classifyStellarAddress(MUXED_ADDRESS).kind).toBe('muxed');
    expect(classifyStellarAddress(CONTRACT_ADDRESS).kind).toBe('contract');
    expect(classifyStellarAddress(CASE_VARIANT_ADDRESS).valid).toBe(false);
    expect(isValidStellarAccountAddress(SENDER)).toBe(true);
    expect(isValidStellarAccountAddress(MUXED_ADDRESS)).toBe(false);
    expect(isValidStellarAccountAddress(CONTRACT_ADDRESS)).toBe(false);
    expect(isValidStellarAccountAddress(CASE_VARIANT_ADDRESS)).toBe(false);
  });
});

