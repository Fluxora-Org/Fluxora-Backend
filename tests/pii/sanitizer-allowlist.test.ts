import { describe, it, expect } from 'vitest';
import { sanitize, maskStellarKey, isStellarKey, redactKeysInString, sanitizeError } from '../../src/pii/sanitizer.js';
import { redactableFields } from '../../src/pii/policy.js';

describe('PII Sanitizer Allowlist', () => {
  describe('redactableFields policy', () => {
    it('should include all sensitive stream fields', () => {
      const fields = redactableFields();
      expect(fields.has('sender')).toBe(true);
      expect(fields.has('recipient')).toBe(true);
    });

    it('should include all sensitive request fields', () => {
      const fields = redactableFields();
      const sensitiveFields = [
        'ipaddress', 'useragent', 'authtoken', 'authorization',
        'x-api-key', 'idempotency-key', 'password', 'secret',
        'token', 'credential', 'key', 'private-key', 'api-key',
        'access-token', 'refresh-token', 'session-id', 'cookie', 'set-cookie'
      ];
      sensitiveFields.forEach(field => {
        expect(fields.has(field)).toBe(true);
      });
    });

    it('should NOT include non-sensitive fields', () => {
      const fields = redactableFields();
      expect(fields.has('id')).toBe(false);
      expect(fields.has('depositamount')).toBe(false);
      expect(fields.has('ratepersecond')).toBe(false);
      expect(fields.has('starttime')).toBe(false);
      expect(fields.has('status')).toBe(false);
    });
  });

  describe('sanitize() - PII field redaction', () => {
    it('should redact sender field with Stellar key mask', () => {
      const obj = { sender: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
      const result = sanitize(obj);
      expect(result.sender).toBe('GAAA..AAAA');
    });

    it('should redact recipient field with Stellar key mask', () => {
      const obj = { recipient: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
      const result = sanitize(obj);
      expect(result.recipient).toBe('GBBB..BBBB');
    });

    it('should redact ipAddress field with [REDACTED]', () => {
      const obj = { ipAddress: '192.168.1.100' };
      const result = sanitize(obj);
      expect(result.ipAddress).toBe('[REDACTED]');
    });

    it('should redact authToken field with [REDACTED]', () => {
      const obj = { authToken: 'bearer-xyz-123' };
      const result = sanitize(obj);
      expect(result.authToken).toBe('[REDACTED]');
    });

    it('should redact password field with [REDACTED]', () => {
      const obj = { password: 'secret123' };
      const result = sanitize(obj);
      expect(result.password).toBe('[REDACTED]');
    });

    it('should handle case-insensitive field matching', () => {
      const obj = { 
        SENDER: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        IpAddress: '10.0.0.1',
        PASSWORD: 'test'
      };
      const result = sanitize(obj);
      expect(result.SENDER).toBe('GAAA..AAAA');
      expect(result.IpAddress).toBe('[REDACTED]');
      expect(result.PASSWORD).toBe('[REDACTED]');
    });
  });

  describe('sanitize() - non-PII fields passthrough', () => {
    it('should pass through id field unchanged', () => {
      const obj = { id: 12345 };
      const result = sanitize(obj);
      expect(result.id).toBe(12345);
    });

    it('should pass through depositAmount field unchanged', () => {
      const obj = { depositAmount: '100.50' };
      const result = sanitize(obj);
      expect(result.depositAmount).toBe('100.50');
    });

    it('should pass through ratePerSecond field unchanged', () => {
      const obj = { ratePerSecond: '0.001' };
      const result = sanitize(obj);
      expect(result.ratePerSecond).toBe('0.001');
    });

    it('should pass through status field unchanged', () => {
      const obj = { status: 'active' };
      const result = sanitize(obj);
      expect(result.status).toBe('active');
    });

    it('should preserve decimal precision in amount strings', () => {
      const obj = { depositAmount: '123.456789012345' };
      const result = sanitize(obj);
      expect(result.depositAmount).toBe('123.456789012345');
    });
  });

  describe('sanitize() - nested objects', () => {
    it('should recursively sanitize nested objects', () => {
      const obj = {
        stream: {
          sender: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          amount: '100.00',
          metadata: {
            ipAddress: '192.168.1.1',
            userAgent: 'Mozilla/5.0'
          }
        }
      };
      const result = sanitize(obj);
      expect(result.stream.sender).toBe('GAAA..AAAA');
      expect(result.stream.amount).toBe('100.00');
      expect(result.stream.metadata.ipAddress).toBe('[REDACTED]');
      expect(result.stream.metadata.userAgent).toBe('[REDACTED]');
    });

    it('should handle deeply nested structures', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              password: 'secret',
              status: 'ok'
            }
          }
        }
      };
      const result = sanitize(obj);
      expect(result.level1.level2.level3.password).toBe('[REDACTED]');
      expect(result.level1.level2.level3.status).toBe('ok');
    });
  });

  describe('sanitize() - arrays', () => {
    it('should sanitize arrays of objects', () => {
      const obj = {
        streams: [
          { sender: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: '100' },
          { sender: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', amount: '200' }
        ]
      };
      const result = sanitize(obj);
      expect(result.streams[0].sender).toBe('GAAA..AAAA');
      expect(result.streams[0].amount).toBe('100');
      expect(result.streams[1].sender).toBe('GBBB..BBBB');
      expect(result.streams[1].amount).toBe('200');
    });

    it('should handle mixed arrays', () => {
      const obj = {
        items: [
          { password: 'test' },
          'string-value',
          42,
          { status: 'active' }
        ]
      };
      const result = sanitize(obj);
      expect(result.items[0].password).toBe('[REDACTED]');
      expect(result.items[1]).toBe('string-value');
      expect(result.items[2]).toBe(42);
      expect(result.items[3].status).toBe('active');
    });
  });

  describe('sanitize() - edge cases', () => {
    it('should handle null values', () => {
      const obj = { sender: null, status: 'active' };
      const result = sanitize(obj);
      expect(result.sender).toBe('[REDACTED]');
      expect(result.status).toBe('active');
    });

    it('should handle undefined values', () => {
      const obj = { sender: undefined, status: 'active' };
      const result = sanitize(obj);
      expect(result.sender).toBe('[REDACTED]');
      expect(result.status).toBe('active');
    });

    it('should handle empty strings in sensitive fields', () => {
      const obj = { password: '', status: 'ok' };
      const result = sanitize(obj);
      expect(result.password).toBe('[REDACTED]');
      expect(result.status).toBe('ok');
    });

    it('should redact non-string sensitive values', () => {
      const obj = { 
        authToken: 12345,
        password: true,
        token: { nested: 'value' }
      };
      const result = sanitize(obj);
      expect(result.authToken).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
    });

    it('should not mutate original object', () => {
      const obj = { 
        sender: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567WXYZ',
        password: 'secret'
      };
      const original = JSON.parse(JSON.stringify(obj));
      sanitize(obj);
      expect(obj.sender).toBe(original.sender);
      expect(obj.password).toBe(original.password);
    });
  });

  describe('Stellar key handling', () => {
    // Valid Stellar key: G + 55 base32 chars [A-Z2-7] = 56 chars total
    const VALID_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    it('should mask valid Stellar public keys', () => {
      expect(maskStellarKey(VALID_KEY)).toBe('GAAA..AAAA');
    });

    it('should return [REDACTED] for invalid Stellar keys', () => {
      expect(maskStellarKey('invalid')).toBe('[REDACTED]');
      expect(maskStellarKey('GABC')).toBe('[REDACTED]');
      expect(maskStellarKey('')).toBe('[REDACTED]');
      // Keys with digits 0,1,8,9 are invalid base32
      expect(maskStellarKey('GABC0189INVALID')).toBe('[REDACTED]');
    });

    it('should detect valid Stellar keys', () => {
      expect(isStellarKey(VALID_KEY)).toBe(true);
    });

    it('should reject invalid Stellar keys', () => {
      expect(isStellarKey('invalid')).toBe(false);
      expect(isStellarKey('GABC')).toBe(false);
      expect(isStellarKey('')).toBe(false);
      // Keys with digits 0,1,8,9 are invalid base32
      expect(isStellarKey('GABC0189INVALID')).toBe(false);
    });

    it('should redact Stellar keys embedded in strings', () => {
      const text = `User ${VALID_KEY} sent funds`;
      const result = redactKeysInString(text);
      expect(result).toBe('User GAAA..AAAA sent funds');
    });

    it('should handle multiple Stellar keys in one string', () => {
      const KEY2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      const text = `From ${VALID_KEY} to ${KEY2}`;
      const result = redactKeysInString(text);
      expect(result).toBe('From GAAA..AAAA to GBBB..BBBB');
    });
  });

  describe('sanitizeError()', () => {
    const VALID_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const KEY2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    it('should redact sensitive data from error messages', () => {
      const error = new Error(`Failed for user ${VALID_KEY}`);
      const result = sanitizeError(error);
      expect(result.message).toBe('Failed for user GAAA..AAAA');
    });

    it('should redact sensitive data from stack traces', () => {
      const error = new Error(`Error with token ${KEY2}`);
      const result = sanitizeError(error);
      expect(result.stack).toContain('GBBB..BBBB');
      expect(result.stack).not.toContain(KEY2);
    });

    it('should preserve error name', () => {
      const error = new Error('Test error');
      error.name = 'CustomError';
      const result = sanitizeError(error);
      expect(result.name).toBe('CustomError');
    });

    it('should sanitize additional error properties via sanitizeValue', () => {
      const error = new Error('Test') as any;
      error.metadata = VALID_KEY;  // non-redactable field name
      error.userId = 456;
      const result = sanitizeError(error);
      // Non-redactable fields pass through unchanged
      expect(result.metadata).toBe(VALID_KEY);
      expect(result.userId).toBe(456);
    });
  });
});
