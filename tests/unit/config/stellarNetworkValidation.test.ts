import { describe, expect, it, vi } from 'vitest';
import {
  assertNetworkMatchesContracts,
  logActiveStellarConfig,
  resolveNetwork,
  STELLAR_CONTRACT_ALLOWLIST,
  type ContractAddresses,
} from '../../../src/config/stellar.js';
import { logger } from '../../../src/lib/logger.js';

const TESTNET_CONTRACT = STELLAR_CONTRACT_ALLOWLIST.testnet.contract[0]!;
const TESTNET_TOKEN = STELLAR_CONTRACT_ALLOWLIST.testnet.token[0]!;
const MAINNET_CONTRACT = STELLAR_CONTRACT_ALLOWLIST.mainnet.contract[0]!;
const MAINNET_TOKEN = STELLAR_CONTRACT_ALLOWLIST.mainnet.token[0]!;
const VALID_UNPINNED = 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM';
const INVALID_STRKEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZOR';

describe('stellar network and contract validation (Issue #1576)', () => {
  describe('assertNetworkMatchesContracts', () => {
    it('passes when configured network is testnet and all contract addresses are testnet', () => {
      const addresses: ContractAddresses = {
        streaming: TESTNET_CONTRACT,
        contract: TESTNET_CONTRACT,
        token: TESTNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('testnet', addresses)).not.toThrow();
    });

    it('passes when configured network is mainnet and all contract addresses are mainnet', () => {
      const addresses: ContractAddresses = {
        streaming: MAINNET_CONTRACT,
        contract: MAINNET_CONTRACT,
        token: MAINNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('mainnet', addresses)).not.toThrow();
    });

    it('fails startup when a testnet contract address is configured for mainnet, naming both in message', () => {
      const addresses: ContractAddresses = {
        streaming: TESTNET_CONTRACT,
        contract: MAINNET_CONTRACT,
        token: MAINNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('mainnet', addresses)).toThrowError(
        /is pinned for testnet but configured network is mainnet/
      );
    });

    it('fails startup when a testnet token address is configured for mainnet, naming both in message', () => {
      const addresses: ContractAddresses = {
        contract: MAINNET_CONTRACT,
        token: TESTNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('mainnet', addresses)).toThrowError(
        /is pinned for testnet but configured network is mainnet/
      );
    });

    it('fails startup when a mainnet contract address is configured for testnet, naming both in message', () => {
      const addresses: ContractAddresses = {
        contract: MAINNET_CONTRACT,
        token: TESTNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('testnet', addresses)).toThrowError(
        /is pinned for mainnet but configured network is testnet/
      );
    });

    it('fails startup when a mainnet token address is configured for testnet, naming both in message', () => {
      const addresses: ContractAddresses = {
        contract: TESTNET_CONTRACT,
        token: MAINNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('testnet', addresses)).toThrowError(
        /is pinned for mainnet but configured network is testnet/
      );
    });

    it('checks every configured contract including custom contract keys', () => {
      const addresses: ContractAddresses = {
        streaming: MAINNET_CONTRACT,
        contract: MAINNET_CONTRACT,
        token: MAINNET_TOKEN,
        customContract: TESTNET_CONTRACT,
      };

      expect(() => assertNetworkMatchesContracts('mainnet', addresses)).toThrowError(
        /customContract.*pinned for testnet but configured network is mainnet/
      );
    });

    it('rejects unallowlisted contract addresses on testnet and mainnet', () => {
      const addresses: ContractAddresses = {
        contract: VALID_UNPINNED,
      };

      expect(() => assertNetworkMatchesContracts('testnet', addresses)).toThrowError(
        /not in the known-good testnet contract address allowlist/
      );
      expect(() => assertNetworkMatchesContracts('mainnet', addresses)).toThrowError(
        /not in the known-good mainnet contract address allowlist/
      );
    });

    it('rejects invalid StrKey formatting on testnet and mainnet', () => {
      const addresses: ContractAddresses = {
        contract: INVALID_STRKEY,
      };

      expect(() => assertNetworkMatchesContracts('testnet', addresses)).toThrowError(
        /must be a valid Stellar contract StrKey/
      );
    });

    it('allows valid unpinned addresses on local network', () => {
      const addresses: ContractAddresses = {
        streaming: VALID_UNPINNED,
        contract: TESTNET_CONTRACT,
        token: MAINNET_TOKEN,
      };

      expect(() => assertNetworkMatchesContracts('local', addresses)).not.toThrow();
    });

    it('rejects invalid StrKey formatting even on local network', () => {
      const addresses: ContractAddresses = {
        contract: INVALID_STRKEY,
      };

      expect(() => assertNetworkMatchesContracts('local', addresses)).toThrowError(
        /must be a valid Stellar contract StrKey/
      );
    });
  });

  describe('logActiveStellarConfig', () => {
    it('logs the active network and contract addresses at startup', () => {
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

      const addresses: ContractAddresses = {
        streaming: MAINNET_CONTRACT,
        contract: MAINNET_CONTRACT,
        token: MAINNET_TOKEN,
      };

      logActiveStellarConfig({
        network: 'mainnet',
        contractAddresses: addresses,
      });

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        'stellar:network_config',
        undefined,
        expect.objectContaining({
          network: 'mainnet',
          contractAddresses: addresses,
          addresses,
        })
      );

      infoSpy.mockRestore();
    });
  });

  describe('resolveNetwork', () => {
    it('resolves explicit STELLAR_NETWORK when provided', () => {
      expect(resolveNetwork({ STELLAR_NETWORK: 'mainnet' })).toBe('mainnet');
      expect(resolveNetwork({ STELLAR_NETWORK: 'testnet' })).toBe('testnet');
      expect(resolveNetwork({ STELLAR_NETWORK: 'local' })).toBe('local');
    });

    it('defaults to mainnet in production when STELLAR_NETWORK is unset', () => {
      expect(resolveNetwork({ NODE_ENV: 'production' })).toBe('mainnet');
    });

    it('defaults to testnet in non-production environments when STELLAR_NETWORK is unset', () => {
      expect(resolveNetwork({ NODE_ENV: 'development' })).toBe('testnet');
      expect(resolveNetwork({ NODE_ENV: 'test' })).toBe('testnet');
    });
  });
});
