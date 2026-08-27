import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StellarAddressValidator } from '../src/validation/stellarAddressValidator.js';
import type { StellarRpcService } from '../src/services/stellar-rpc.js';
import { classifyStellarAddress, isValidStellarAccountAddress } from '../src/validation/stellarAddress.js';

const NETWORK = 'testnet' as const;

// A structurally valid account StrKey on the configured network.
const VALID_ADDRESS_1 = 'GAAREIZUIVLGO6EJTKV3ZTO654ABCIRTIRKWM54ITGVLXTG5537RAI5F';
const VALID_ADDRESS_2 = 'GBNWY7MOT6YMDUXD6QCRMJZYJFNGW7ENT2X4BUPC6MCBKJRXJBMWUCQH';
// Valid StrKey *shape* but absent on the configured network (wrong-network).
const INVALID_ADDRESS = 'GBADADDR000000000000000000000000000000000000000000000000';
// Muxed account (`M…`) — valid StrKey, wrong type for an account field.
const MUXED_ADDRESS = 'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5IG';
// Contract StrKey (`C…`) — valid StrKey, wrong type for an account field.
const CONTRACT_ADDRESS = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';
// Lowercase / case-variant input — must be rejected.
const CASE_VARIANT_ADDRESS = 'gaareizuivlgo6ejtkv3zto654abcirtirkwm54itgvlxtg5537rai5f';

function makeMockRpc(allowlist: Set<string>): StellarRpcService {
  return {
    accountExists: vi.fn(async (address: string) => allowlist.has(address)),
  } as unknown as StellarRpcService;
}

const mockRedis = null;

function validatorFor(rpc: StellarRpcService): StellarAddressValidator {
  return new StellarAddressValidator(rpc, mockRedis, 300, NETWORK);
}

describe('StellarAddressValidator allowlist validation', () => {
  let rpc: StellarRpcService;

  beforeEach(() => {
    rpc = makeMockRpc(new Set([VALID_ADDRESS_1, VALID_ADDRESS_2]));
  });

  it('returns valid when both addresses are in the allowlist', async () => {
    const result = await validatorFor(rpc).validate(VALID_ADDRESS_1, VALID_ADDRESS_2);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when sender is not in the allowlist', async () => {
    const result = await validatorFor(rpc).validate(INVALID_ADDRESS, VALID_ADDRESS_2);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(INVALID_ADDRESS);
  });

  it('returns invalid when recipient is not in the allowlist', async () => {
    const result = await validatorFor(rpc).validate(VALID_ADDRESS_1, INVALID_ADDRESS);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(INVALID_ADDRESS);
  });

  it('returns invalid with both missing addresses listed when neither exists', async () => {
    const result = await validatorFor(rpc).validate(
      INVALID_ADDRESS,
      'GCOTHER00000000000000000000000000000000000000000000000000'
    );
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toHaveLength(2);
  });

  it('fails open when rpc throws', async () => {
    const brokenRpc = {
      accountExists: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    } as unknown as StellarRpcService;
    const result = await validatorFor(brokenRpc).validate(VALID_ADDRESS_1, VALID_ADDRESS_2);
    expect(result.valid).toBe(true);
  });
});

describe('StellarAddressValidator network-aware contract', () => {
  it('rejects a muxed address before any RPC call (type mismatch)', async () => {
    const rpc = makeMockRpc(new Set());
    const result = await validatorFor(rpc).validate(MUXED_ADDRESS, VALID_ADDRESS_2);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([MUXED_ADDRESS]);
    expect(result.reasons?.[MUXED_ADDRESS]).toBe('malformed');
    expect(rpc.accountExists).not.toHaveBeenCalledWith(MUXED_ADDRESS);
  });

  it('rejects a contract address supplied where an account is expected', async () => {
    const rpc = makeMockRpc(new Set());
    const result = await validatorFor(rpc).validate(VALID_ADDRESS_1, CONTRACT_ADDRESS);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([CONTRACT_ADDRESS]);
    expect(result.reasons?.[CONTRACT_ADDRESS]).toBe('malformed');
  });

  it('rejects a lowercase / case-variant address', async () => {
    const rpc = makeMockRpc(new Set());
    const result = await validatorFor(rpc).validate(CASE_VARIANT_ADDRESS, VALID_ADDRESS_2);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([CASE_VARIANT_ADDRESS]);
    expect(result.reasons?.[CASE_VARIANT_ADDRESS]).toBe('malformed');
    expect(rpc.accountExists).not.toHaveBeenCalledWith(CASE_VARIANT_ADDRESS);
  });

  it('marks a structurally valid but absent address as wrong-network', async () => {
    // Valid StrKey shape, but the configured network's RPC reports it absent.
    const rpc = makeMockRpc(new Set([VALID_ADDRESS_2]));
    const result = await validatorFor(rpc).validate(VALID_ADDRESS_1, VALID_ADDRESS_2);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toEqual([VALID_ADDRESS_1]);
    expect(result.reasons?.[VALID_ADDRESS_1]).toBe('wrong-network');
  });

  it('classifies address kinds consistently (account / muxed / contract / case)', () => {
    expect(classifyStellarAddress(VALID_ADDRESS_1)).toMatchObject({ kind: 'account', valid: true });
    expect(classifyStellarAddress(MUXED_ADDRESS).kind).toBe('muxed');
    expect(classifyStellarAddress(CONTRACT_ADDRESS).kind).toBe('contract');
    expect(classifyStellarAddress(CASE_VARIANT_ADDRESS).valid).toBe(false);
    expect(isValidStellarAccountAddress(VALID_ADDRESS_1)).toBe(true);
    expect(isValidStellarAccountAddress(MUXED_ADDRESS)).toBe(false);
    expect(isValidStellarAccountAddress(CONTRACT_ADDRESS)).toBe(false);
    expect(isValidStellarAccountAddress(CASE_VARIANT_ADDRESS)).toBe(false);
  });
});

