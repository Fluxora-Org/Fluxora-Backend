import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StellarAddressValidator } from '../src/validation/stellarAddressValidator.js';
import type { StellarRpcService } from '../src/services/stellar-rpc.js';

const VALID_ADDRESS_1 = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const VALID_ADDRESS_2 = 'GBVVJJHAN5M34MSDMTSMLQZQOJON4CSYFWNIRLDXEAEDTIFWALKFYBVK';
const INVALID_ADDRESS = 'GBADADDR000000000000000000000000000000000000000000000000';

function makeMockRpc(allowlist: Set<string>): StellarRpcService {
  return {
    accountExists: vi.fn(async (address: string) => allowlist.has(address)),
  } as unknown as StellarRpcService;
}

const mockRedis = null;

describe('StellarAddressValidator allowlist validation', () => {
  let rpc: StellarRpcService;

  beforeEach(() => {
    rpc = makeMockRpc(new Set([VALID_ADDRESS_1, VALID_ADDRESS_2]));
  });

  it('returns valid when both addresses are in the allowlist', async () => {
    const validator = new StellarAddressValidator(rpc, mockRedis, 300);
    const result = await validator.validate(VALID_ADDRESS_1, VALID_ADDRESS_2);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when sender is not in the allowlist', async () => {
    const validator = new StellarAddressValidator(rpc, mockRedis, 300);
    const result = await validator.validate(INVALID_ADDRESS, VALID_ADDRESS_2);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(INVALID_ADDRESS);
  });

  it('returns invalid when recipient is not in the allowlist', async () => {
    const validator = new StellarAddressValidator(rpc, mockRedis, 300);
    const result = await validator.validate(VALID_ADDRESS_1, INVALID_ADDRESS);
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toContain(INVALID_ADDRESS);
  });

  it('returns invalid with both missing addresses listed when neither exists', async () => {
    const validator = new StellarAddressValidator(rpc, mockRedis, 300);
    const result = await validator.validate(INVALID_ADDRESS, 'GCOTHER00000000000000000000000000000000000000000000000000');
    expect(result.valid).toBe(false);
    expect(result.missingAddresses).toHaveLength(2);
  });

  it('fails open when rpc throws', async () => {
    const brokenRpc = {
      accountExists: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    } as unknown as StellarRpcService;
    const validator = new StellarAddressValidator(brokenRpc, mockRedis, 300);
    const result = await validator.validate(VALID_ADDRESS_1, VALID_ADDRESS_2);
    expect(result.valid).toBe(true);
  });
});
