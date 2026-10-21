import { describe, expect, it } from 'vitest';
import {
  resolveNetwork,
  StellarNetworkInputError,
  STELLAR_NETWORKS,
} from './stellar.js';

describe('Stellar network configuration', () => {
  it('keeps the built-in network configurations valid', () => {
    expect(Object.keys(STELLAR_NETWORKS)).toEqual(['testnet', 'mainnet', 'local']);
    for (const config of Object.values(STELLAR_NETWORKS)) {
      expect(config.horizonUrl).toMatch(/^https?:\/\//);
      expect(config.passphrase).not.toBe('');
      expect(config.networkPassphrase).toBe(config.passphrase);
    }
  });

  it.each([
    ['testnet', 'testnet'],
    ['mainnet', 'mainnet'],
    ['local', 'local'],
  ] as const)('resolves a valid explicit network: %s', (configuredNetwork, expected) => {
    expect(resolveNetwork({ STELLAR_NETWORK: configuredNetwork })).toBe(expected);
  });

  it('preserves defaults when no explicit network is configured', () => {
    expect(resolveNetwork({ NODE_ENV: 'production' })).toBe('mainnet');
    expect(resolveNetwork({ NODE_ENV: 'development' })).toBe('testnet');
    expect(resolveNetwork({})).toBe('testnet');
  });

  it.each([
    ['', 'empty'],
    [' \t ', 'empty'],
    ['unknown', 'malformed'],
    [null, 'malformed'],
    ['testnetx', 'oversized'],
    ['network-that-is-too-long', 'oversized'],
  ] as const)('rejects invalid network input without mutating it: %s', (value, reason) => {
    const input = Object.freeze({
      STELLAR_NETWORK: value,
      NODE_ENV: 'production',
    });
    let thrown: unknown;

    try {
      resolveNetwork(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StellarNetworkInputError);
    expect(thrown).toMatchObject({ reason });
    expect(input).toEqual({ STELLAR_NETWORK: value, NODE_ENV: 'production' });
  });
});
