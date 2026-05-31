import type { StellarNetwork } from './stellar.js';

export type PinnedStellarNetwork = Extract<StellarNetwork, 'testnet' | 'mainnet'>;
export type PinnedStellarAddressKind = 'contract' | 'token';

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
    token: ['CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6'],
  },
  mainnet: {
    contract: ['CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA'],
    token: ['CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5'],
  },
} as const;

export const STELLAR_NETWORK_PASSPHRASES: Record<PinnedStellarNetwork, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
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
  const actualChecksum = decoded[STELLAR_STRKEY_PAYLOAD_LENGTH]!
    | (decoded[STELLAR_STRKEY_PAYLOAD_LENGTH + 1]! << 8);

  return expectedChecksum === actualChecksum;
}

export function getPinnedAddressNetwork(
  kind: PinnedStellarAddressKind,
  address: string,
): PinnedStellarNetwork | null {
  for (const network of Object.keys(STELLAR_CONTRACT_ALLOWLIST) as PinnedStellarNetwork[]) {
    if (STELLAR_CONTRACT_ALLOWLIST[network][kind].includes(address)) {
      return network;
    }
  }

  return null;
}
