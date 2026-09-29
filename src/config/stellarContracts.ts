import type { StellarNetwork, ContractAddresses } from './stellar.js';
import { logger } from '../lib/logger.js';

export type PinnedStellarNetwork = Extract<StellarNetwork, 'testnet' | 'mainnet'>;
export type PinnedStellarAddressKind = 'contract' | 'token' | 'streaming';

const STELLAR_CONTRACT_VERSION_BYTE = 2 << 3;
const STELLAR_STRKEY_LENGTH = 56;
const STELLAR_STRKEY_DECODED_LENGTH = 35;
const STELLAR_STRKEY_PAYLOAD_LENGTH = 33;
const STELLAR_STRKEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const STELLAR_CONTRACT_ALLOWLIST: Record<
  PinnedStellarNetwork,
  Record<PinnedStellarAddressKind, readonly string[]>
> = {
  testnet: {
    contract: ['CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC'],
    streaming: ['CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC'],
    token: ['CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6'],
  },
  mainnet: {
    contract: ['CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA'],
    streaming: ['CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA'],
    token: ['CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5'],
  },
} as const;

export const STELLAR_NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  local: 'Standalone Network ; February 2017',
} as const;

function decodeStellarBase32(value: string): number[] | null {
  const bytes: number[] = [];
  let bits = 0;
  let current = 0;

  for (const char of value) {
    const digit = STELLAR_STRKEY_ALPHABET.indexOf(char);
    if (digit === -1) return null;

    current = (current << 5) | digit;
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return bytes;
}

function crc16XModem(bytes: readonly number[]): number {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc;
}

export function isValidStellarContractAddress(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length !== STELLAR_STRKEY_LENGTH || !/^C[A-Z2-7]{55}$/.test(candidate)) {
    return false;
  }

  const decoded = decodeStellarBase32(candidate);
  if (decoded === null || decoded.length !== STELLAR_STRKEY_DECODED_LENGTH) {
    return false;
  }

  if (decoded[0] !== STELLAR_CONTRACT_VERSION_BYTE) {
    return false;
  }

  const payload = decoded.slice(0, STELLAR_STRKEY_PAYLOAD_LENGTH);
  const expectedChecksum = crc16XModem(payload);
  const actualChecksum =
    decoded[STELLAR_STRKEY_PAYLOAD_LENGTH]! | (decoded[STELLAR_STRKEY_PAYLOAD_LENGTH + 1]! << 8);

  return expectedChecksum === actualChecksum;
}

/**
 * Decode a Stellar contract StrKey (`C…`) into its 32-byte contract id, or
 * `null` when the value is not a valid contract address (bad length, alphabet,
 * version byte, or CRC16). Used by the startup reachability check to build the
 * contract-instance ledger key (issue #1438).
 */
export function stellarContractIdBytes(address: string): Uint8Array | null {
  const candidate = address.trim();
  if (!isValidStellarContractAddress(candidate)) return null;

  const decoded = decodeStellarBase32(candidate);
  if (decoded === null || decoded.length !== STELLAR_STRKEY_DECODED_LENGTH) return null;

  // Layout: 1 version byte, then the 32-byte contract id, then a 2-byte checksum.
  return Uint8Array.from(decoded.slice(1, 1 + 32));
}

export function getPinnedAddressNetwork(
  kind: PinnedStellarAddressKind,
  address: string
): PinnedStellarNetwork | null {
  const allowlistKind = kind === 'streaming' ? 'contract' : kind;
  for (const network of Object.keys(STELLAR_CONTRACT_ALLOWLIST) as PinnedStellarNetwork[]) {
    if (STELLAR_CONTRACT_ALLOWLIST[network][allowlistKind].includes(address)) {
      return network;
    }
  }

  return null;
}

export function getAddressPinnedNetwork(address: string): PinnedStellarNetwork | null {
  for (const network of Object.keys(STELLAR_CONTRACT_ALLOWLIST) as PinnedStellarNetwork[]) {
    for (const kind of Object.keys(
      STELLAR_CONTRACT_ALLOWLIST[network]
    ) as PinnedStellarAddressKind[]) {
      if (STELLAR_CONTRACT_ALLOWLIST[network][kind].includes(address)) {
        return network;
      }
    }
  }

  return null;
}

export function assertNetworkMatchesContracts(
  network: StellarNetwork,
  addresses: ContractAddresses
): void {
  if (network === 'local') {
    for (const [name, address] of Object.entries(addresses)) {
      if (address && !isValidStellarContractAddress(address)) {
        throw new Error(
          `Contract address mismatch: "${name}" (${address}) must be a valid Stellar contract StrKey`
        );
      }
    }
    return;
  }

  for (const [name, address] of Object.entries(addresses)) {
    if (!address) continue;

    if (!isValidStellarContractAddress(address)) {
      throw new Error(
        `Contract address mismatch: "${name}" (${address}) must be a valid Stellar contract StrKey`
      );
    }

    const kind: PinnedStellarAddressKind =
      name === 'token' ? 'token' : name === 'streaming' ? 'streaming' : 'contract';
    const pinnedNetwork = getPinnedAddressNetwork(kind, address);

    if (pinnedNetwork !== network) {
      if (pinnedNetwork !== null) {
        throw new Error(
          `Contract address mismatch: "${name}" (${address}) is pinned for ${pinnedNetwork} but configured network is ${network}`
        );
      } else {
        const anyPinnedNetwork = getAddressPinnedNetwork(address);
        if (anyPinnedNetwork !== null) {
          throw new Error(
            `Contract address mismatch: "${name}" (${address}) is pinned for ${anyPinnedNetwork} but configured network is ${network}`
          );
        }
        throw new Error(
          `Contract address mismatch: "${name}" (${address}) is not in the known-good ${network} ${kind} address allowlist`
        );
      }
    }
  }
}

export function logActiveStellarConfig(config: {
  network: StellarNetwork;
  contractAddresses: ContractAddresses;
}): void {
  logger.info('stellar:network_config', undefined, {
    network: config.network,
    contractAddresses: config.contractAddresses,
    addresses: config.contractAddresses,
  });
}

/**
 * Validate the pinned contract allowlist and network passphrases (issue #1437).
 *
 * These tables are static module data, but if an entry were ever edited into
 * an invalid StrKey the mismatch would only surface when a request tried to
 * verify or resolve an address. Validate them at startup instead. Overrides
 * are injectable for tests.
 */
export function validateStellarContractsConfig(
  allowlist: Record<
    PinnedStellarNetwork,
    Record<PinnedStellarAddressKind, readonly string[]>
  > = STELLAR_CONTRACT_ALLOWLIST,
  passphrases: Record<StellarNetwork, string> = STELLAR_NETWORK_PASSPHRASES,
): string[] {
  const issues: string[] = [];

  for (const network of Object.keys(allowlist) as PinnedStellarNetwork[]) {
    for (const kind of ['contract', 'token'] as PinnedStellarAddressKind[]) {
      const entries = allowlist[network][kind];
      entries.forEach((address, index) => {
        if (!isValidStellarContractAddress(address)) {
          issues.push(
            `STELLAR_CONTRACT_ALLOWLIST.${network}.${kind}[${index}] must be a valid Stellar contract StrKey (got "${address}")`,
          );
        }
      });
    }
  }

  for (const network of Object.keys(passphrases) as StellarNetwork[]) {
    if (typeof passphrases[network] !== 'string' || passphrases[network].trim() === '') {
      issues.push(`STELLAR_NETWORK_PASSPHRASES.${network} must be a non-empty string`);
    }
  }

  return issues;
}
