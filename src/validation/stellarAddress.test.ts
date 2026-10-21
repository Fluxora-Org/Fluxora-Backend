import { describe, expect, it } from 'vitest';
import {
  STELLAR_ACCOUNT_CACHE_PREFIX,
  STELLAR_ACCOUNT_PUBLIC_KEY_REGEX,
  STELLAR_MUXED_STRKEY_DECODED_LENGTH,
  STELLAR_MUXED_STRKEY_LENGTH,
  STELLAR_MUXED_STRKEY_PAYLOAD_LENGTH,
  STELLAR_STRKEY_ALPHABET,
  STELLAR_STRKEY_DECODED_LENGTH,
  STELLAR_STRKEY_LENGTH,
  STELLAR_STRKEY_PAYLOAD_LENGTH,
  STELLAR_STRKEY_VERSION,
  classifyStellarAddress,
  crc16XModem,
  decodeStellarBase32,
  isValidStellarAccountAddress,
  networkLabel,
} from './stellarAddress.js';

// Checksum-valid StrKeys (CRC16-XModem verified, SEP-23 framing).
const ACCOUNT_ADDRESS = 'GAAREIZUIVLGO6EJTKV3ZTO654ABCIRTIRKWM54ITGVLXTG5537RAI5F';
const SECOND_ACCOUNT_ADDRESS = 'GBNWY7MOT6YMDUXD6QCRMJZYJFNGW7ENT2X4BUPC6MCBKJRXJBMWUCQH';
const MUXED_ADDRESS = 'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5IG';
const CONTRACT_ADDRESS = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';

const ALPHABET_REASON =
  'address contains characters outside the Stellar base32 alphabet (expected uppercase A-Z and 2-7)';

function encodeStellarBase32(bytes: readonly number[]): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += STELLAR_STRKEY_ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += STELLAR_STRKEY_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function makeStrKey(version: number, decodedLength: number): string {
  const payloadLength = decodedLength - 2;
  const payload = [
    version,
    ...Array.from({ length: payloadLength - 1 }, (_, i) => (i * 7 + 13) & 0xff),
  ];
  const checksum = crc16XModem(payload);
  return encodeStellarBase32([...payload, checksum & 0xff, (checksum >> 8) & 0xff]);
}

function corruptChecksum(value: string): string {
  const index = value.length - 1;
  return value.slice(0, index) + (value[index] === 'A' ? 'B' : 'A') + value.slice(index + 1);
}

describe('decodeStellarBase32', () => {
  it('decodes the RFC 4648 test vectors for unpadded uppercase base32', () => {
    expect(decodeStellarBase32('MZXW6YTBOI')).toEqual([102, 111, 111, 98, 97, 114]);
    expect(decodeStellarBase32('777777')).toEqual([255, 255, 255]);
  });

  it('decodes a 56-character account StrKey into 35 bytes', () => {
    const decoded = decodeStellarBase32(ACCOUNT_ADDRESS);
    expect(decoded).toHaveLength(35);
    expect(decoded?.[0]).toBe(STELLAR_STRKEY_VERSION.account);
  });

  it('returns an empty array for empty input', () => {
    expect(decodeStellarBase32('')).toEqual([]);
  });

  it('returns null when a character falls outside the base32 alphabet', () => {
    expect(decodeStellarBase32('mzxw6ytboi')).toBeNull();
    expect(decodeStellarBase32('MAAAAAA0')).toBeNull();
  });
});

describe('crc16XModem', () => {
  it('matches the CRC-16/XMODEM check value for "123456789"', () => {
    const bytes = Array.from('123456789', (char) => char.charCodeAt(0));
    expect(crc16XModem(bytes)).toBe(0x31c3);
  });

  it('returns zero for empty input', () => {
    expect(crc16XModem([])).toBe(0);
  });

  it('is order sensitive', () => {
    expect(crc16XModem([1, 2])).toBe(0x1373);
    expect(crc16XModem([2, 1])).toBe(0x7643);
  });

  it('stays masked to 16 bits for large all-0xff input', () => {
    expect(crc16XModem(Array.from({ length: 32 }, () => 0xff))).toBe(0x84b4);
  });
});

describe('classifyStellarAddress', () => {
  it('rejects non-string input', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(classifyStellarAddress(value)).toEqual({
        kind: 'invalid',
        valid: false,
        reason: 'address must be a string',
      });
    }
  });

  it('rejects empty input at the length boundary', () => {
    expect(classifyStellarAddress('')).toEqual({
      kind: 'invalid',
      valid: false,
      reason: 'expected 56 characters, got 0',
    });
  });

  it('rejects input either side of the 56-character boundary', () => {
    expect(classifyStellarAddress(ACCOUNT_ADDRESS.slice(0, 55))).toEqual({
      kind: 'invalid',
      valid: false,
      reason: 'expected 56 characters, got 55',
    });
    expect(classifyStellarAddress(`${ACCOUNT_ADDRESS}A`)).toEqual({
      kind: 'invalid',
      valid: false,
      reason: 'expected 56 characters, got 57',
    });
  });

  it('classifies a checksum-valid muxed StrKey at the 69-character boundary', () => {
    expect(MUXED_ADDRESS).toHaveLength(STELLAR_MUXED_STRKEY_LENGTH);
    expect(classifyStellarAddress(MUXED_ADDRESS)).toEqual({ kind: 'muxed', valid: true });
  });

  it('treats 68 and 70 characters as malformed rather than muxed', () => {
    expect(classifyStellarAddress('M'.padEnd(68, 'A'))).toEqual({
      kind: 'invalid',
      valid: false,
      reason: 'expected 56 characters, got 68',
    });
    expect(classifyStellarAddress('M'.padEnd(70, 'A'))).toEqual({
      kind: 'invalid',
      valid: false,
      reason: 'expected 56 characters, got 70',
    });
  });

  it('rejects lowercase / case-variant input before decoding', () => {
    expect(classifyStellarAddress(ACCOUNT_ADDRESS.toLowerCase())).toEqual({
      kind: 'invalid',
      valid: false,
      reason: ALPHABET_REASON,
    });
  });

  it('rejects digits such as 0, 1, 8 and 9 that are outside the alphabet', () => {
    const malformed = `${ACCOUNT_ADDRESS.slice(0, 10)}0${ACCOUNT_ADDRESS.slice(11)}`;
    expect(classifyStellarAddress(malformed)).toEqual({
      kind: 'invalid',
      valid: false,
      reason: ALPHABET_REASON,
    });
  });

  it('classifies a valid account StrKey', () => {
    expect(classifyStellarAddress(ACCOUNT_ADDRESS)).toEqual({ kind: 'account', valid: true });
    expect(classifyStellarAddress(SECOND_ACCOUNT_ADDRESS)).toEqual({ kind: 'account', valid: true });
    const generated = makeStrKey(STELLAR_STRKEY_VERSION.account, STELLAR_STRKEY_DECODED_LENGTH);
    expect(generated.startsWith('G')).toBe(true);
    expect(classifyStellarAddress(generated)).toEqual({ kind: 'account', valid: true });
  });

  it('classifies a valid contract StrKey', () => {
    expect(classifyStellarAddress(CONTRACT_ADDRESS)).toEqual({ kind: 'contract', valid: true });
  });

  it('classifies seed, pre-auth tx and hash preimage StrKeys as their own kinds', () => {
    expect(
      classifyStellarAddress(makeStrKey(STELLAR_STRKEY_VERSION.seed, STELLAR_STRKEY_DECODED_LENGTH))
    ).toEqual({ kind: 'seed', valid: true });
    expect(
      classifyStellarAddress(
        makeStrKey(STELLAR_STRKEY_VERSION.preAuthTx, STELLAR_STRKEY_DECODED_LENGTH)
      )
    ).toEqual({ kind: 'preAuthTx', valid: true });
    expect(
      classifyStellarAddress(makeStrKey(STELLAR_STRKEY_VERSION.hashX, STELLAR_STRKEY_DECODED_LENGTH))
    ).toEqual({ kind: 'hashX', valid: true });
  });

  it('reports a checksum mismatch without losing the detected kind', () => {
    expect(classifyStellarAddress(corruptChecksum(ACCOUNT_ADDRESS))).toEqual({
      kind: 'account',
      valid: false,
      reason: 'StrKey checksum mismatch',
    });
    expect(classifyStellarAddress(corruptChecksum(MUXED_ADDRESS))).toEqual({
      kind: 'muxed',
      valid: false,
      reason: 'StrKey checksum mismatch',
    });
  });

  it('rejects an unrecognized StrKey version byte', () => {
    expect(classifyStellarAddress(makeStrKey(0x20, STELLAR_STRKEY_DECODED_LENGTH))).toEqual({
      kind: 'invalid',
      valid: false,
      reason: 'unrecognized StrKey version byte 0x20',
    });
  });
});

describe('isValidStellarAccountAddress', () => {
  it('accepts structurally valid account StrKeys', () => {
    expect(isValidStellarAccountAddress(ACCOUNT_ADDRESS)).toBe(true);
    expect(isValidStellarAccountAddress(SECOND_ACCOUNT_ADDRESS)).toBe(true);
    const generated = makeStrKey(STELLAR_STRKEY_VERSION.account, STELLAR_STRKEY_DECODED_LENGTH);
    expect(isValidStellarAccountAddress(generated)).toBe(true);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(isValidStellarAccountAddress('')).toBe(false);
    expect(isValidStellarAccountAddress(' ')).toBe(false);
    expect(isValidStellarAccountAddress('\t\n')).toBe(false);
  });

  it('rejects surrounding whitespace around a valid address (no trimming)', () => {
    expect(isValidStellarAccountAddress(` ${ACCOUNT_ADDRESS} `)).toBe(false);
  });

  it('rejects lowercase / case-variant input', () => {
    expect(isValidStellarAccountAddress(ACCOUNT_ADDRESS.toLowerCase())).toBe(false);
  });

  it('rejects lengths either side of the 56-character boundary', () => {
    expect(isValidStellarAccountAddress(ACCOUNT_ADDRESS.slice(0, 55))).toBe(false);
    expect(isValidStellarAccountAddress(`${ACCOUNT_ADDRESS}A`)).toBe(false);
  });

  it('rejects every non-account StrKey kind', () => {
    expect(isValidStellarAccountAddress(MUXED_ADDRESS)).toBe(false);
    expect(isValidStellarAccountAddress(CONTRACT_ADDRESS)).toBe(false);
    expect(
      isValidStellarAccountAddress(
        makeStrKey(STELLAR_STRKEY_VERSION.seed, STELLAR_STRKEY_DECODED_LENGTH)
      )
    ).toBe(false);
    expect(
      isValidStellarAccountAddress(
        makeStrKey(STELLAR_STRKEY_VERSION.preAuthTx, STELLAR_STRKEY_DECODED_LENGTH)
      )
    ).toBe(false);
    expect(
      isValidStellarAccountAddress(
        makeStrKey(STELLAR_STRKEY_VERSION.hashX, STELLAR_STRKEY_DECODED_LENGTH)
      )
    ).toBe(false);
  });

  it('rejects a corrupted checksum', () => {
    expect(isValidStellarAccountAddress(corruptChecksum(ACCOUNT_ADDRESS))).toBe(false);
  });

  it('rejects non-string input', () => {
    for (const value of [null, undefined, 42, {}]) {
      expect(isValidStellarAccountAddress(value)).toBe(false);
    }
  });
});

describe('networkLabel', () => {
  it('returns each configured network verbatim', () => {
    expect(networkLabel('testnet')).toBe('testnet');
    expect(networkLabel('mainnet')).toBe('mainnet');
    expect(networkLabel('local')).toBe('local');
  });
});

describe('exported StrKey constants', () => {
  it('pins the account and muxed frame sizes', () => {
    expect(STELLAR_STRKEY_LENGTH).toBe(56);
    expect(STELLAR_STRKEY_DECODED_LENGTH).toBe(35);
    expect(STELLAR_STRKEY_PAYLOAD_LENGTH).toBe(33);
    expect(STELLAR_MUXED_STRKEY_LENGTH).toBe(69);
    expect(STELLAR_MUXED_STRKEY_DECODED_LENGTH).toBe(43);
    expect(STELLAR_MUXED_STRKEY_PAYLOAD_LENGTH).toBe(41);
  });

  it('pins the base32 alphabet and the Redis cache prefix', () => {
    expect(STELLAR_STRKEY_ALPHABET).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
    expect(STELLAR_ACCOUNT_CACHE_PREFIX).toBe('fluxora:stellar:account:');
  });

  it('pins the version byte of every known StrKey kind', () => {
    expect(STELLAR_STRKEY_VERSION).toEqual({
      account: 0x30,
      muxed: 0x60,
      contract: 0x10,
      seed: 0x90,
      preAuthTx: 0x98,
      hashX: 0xb8,
    });
  });

  it('matches only 56-character G-prefixed uppercase base32 in the structural regex', () => {
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(ACCOUNT_ADDRESS)).toBe(true);
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(SECOND_ACCOUNT_ADDRESS)).toBe(true);
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(ACCOUNT_ADDRESS.toLowerCase())).toBe(false);
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(ACCOUNT_ADDRESS.slice(0, 55))).toBe(false);
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(`${ACCOUNT_ADDRESS}A`)).toBe(false);
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(MUXED_ADDRESS)).toBe(false);
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(CONTRACT_ADDRESS)).toBe(false);
  });

  it('leaves checksum verification out of the structural regex by design', () => {
    const checksumIgnored = 'G'.padEnd(STELLAR_STRKEY_LENGTH, 'A');
    expect(STELLAR_ACCOUNT_PUBLIC_KEY_REGEX.test(checksumIgnored)).toBe(true);
    expect(classifyStellarAddress(checksumIgnored)).toEqual({
      kind: 'account',
      valid: false,
      reason: 'StrKey checksum mismatch',
    });
  });
});
