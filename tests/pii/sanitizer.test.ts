import { describe, it, expect } from 'vitest';
import { maskStellarKey, sanitize, isStellarKey, redactKeysInString } from '../../src/pii/sanitizer.js';

// Valid Stellar public key (56 chars, starts with G, base32 alphabet)
const VALID_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const ANOTHER_KEY = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

describe('maskStellarKey()', () => {
  it('masks a valid Stellar key preserving first 4 and last 4 chars', () => {
    const masked = maskStellarKey(VALID_KEY);
    expect(masked).toBe('GAAZ..CWN7');
  });

  it('returns [REDACTED] for non-Stellar strings', () => {
    expect(maskStellarKey('not-a-key')).toBe('[REDACTED]');
    expect(maskStellarKey('')).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for keys with wrong prefix', () => {
    const badPrefix = 'XAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    expect(maskStellarKey(badPrefix)).toBe('[REDACTED]');
  });
});

describe('sanitize()', () => {
  it('redacts sender and recipient fields in a flat object', () => {
    const input = {
      id: 'stream-1',
      sender: VALID_KEY,
      recipient: ANOTHER_KEY,
      depositAmount: '1000',
      status: 'active',
    };
    const result = sanitize(input);

    expect(result.id).toBe('stream-1');
    expect(result.sender).toBe('GAAZ..CWN7');
    expect(result.recipient).toBe('GBDE..DUXR');
    expect(result.depositAmount).toBe('1000');
    expect(result.status).toBe('active');
  });

  it('does not mutate the original object', () => {
    const input = { sender: VALID_KEY, id: '1' };
    const result = sanitize(input);
    expect(input.sender).toBe(VALID_KEY);
    expect(result.sender).not.toBe(VALID_KEY);
  });

  it('handles nested objects', () => {
    const input = {
      stream: { sender: VALID_KEY, id: 'nested' },
    };
    const result = sanitize(input);
    expect((result.stream as Record<string, unknown>).sender).toBe('GAAZ..CWN7');
    expect((result.stream as Record<string, unknown>).id).toBe('nested');
  });

  it('handles arrays of objects', () => {
    const input = {
      streams: [
        { sender: VALID_KEY, id: '1' },
        { sender: ANOTHER_KEY, id: '2' },
      ],
    };
    const result = sanitize(input);
    const streams = result.streams as Array<Record<string, unknown>>;
    expect(streams[0].sender).toBe('GAAZ..CWN7');
    expect(streams[1].sender).toBe('GBDE..DUXR');
  });

  it('redacts null and undefined sensitive fields', () => {
    const input = { sender: null, recipient: undefined, id: '1' };
    const result = sanitize(input as Record<string, unknown>);
    expect(result.sender).toBe('[REDACTED]');
    expect(result.recipient).toBe('[REDACTED]');
  });

  it('redacts non-string sensitive fields with generic marker', () => {
    const input = { sender: 12345, id: '1' };
    const result = sanitize(input as unknown as Record<string, unknown>);
    expect(result.sender).toBe('[REDACTED]');
  });

  it('redacts ipAddress and authToken from request metadata', () => {
    const input = { ipAddress: '192.168.1.1', authToken: 'Bearer xyz', method: 'GET' };
    const result = sanitize(input);
    expect(result.ipAddress).toBe('[REDACTED]');
    expect(result.authToken).toBe('[REDACTED]');
    expect(result.method).toBe('GET');
  });
});

describe('isStellarKey()', () => {
  it('returns true for valid Stellar keys', () => {
    expect(isStellarKey(VALID_KEY)).toBe(true);
  });

  it('returns false for invalid strings', () => {
    expect(isStellarKey('not-a-key')).toBe(false);
    expect(isStellarKey('')).toBe(false);
    expect(isStellarKey('G' + 'A'.repeat(55))).toBe(true); // 55 base32 chars after G = 56 total
    expect(isStellarKey('G' + 'A'.repeat(54))).toBe(false); // 55 total, too short
  });
});

describe('redactKeysInString()', () => {
  it('masks Stellar keys embedded in a log line', () => {
    const line = `Created stream for sender ${VALID_KEY} and recipient ${ANOTHER_KEY}`;
    const result = redactKeysInString(line);
    expect(result).toContain('GAAZ..CWN7');
    expect(result).toContain('GBDE..DUXR');
    expect(result).not.toContain(VALID_KEY);
    expect(result).not.toContain(ANOTHER_KEY);
  });

  it('returns the string unchanged when no keys are present', () => {
    const line = 'No keys here, just normal text.';
    expect(redactKeysInString(line)).toBe(line);
  });

  it('handles empty string', () => {
    expect(redactKeysInString('')).toBe('');
  });
});
