import { describe, it, expect } from 'vitest';
import { hashStringSHA256 } from '../../src/lib/security.js';

describe('security helpers', () => {
  describe('hashStringSHA256', () => {
    it('computes SHA-256 hash correctly', () => {
      // "test" -> 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
      const hash = hashStringSHA256('test');
      expect(hash).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    });

    it('handles undefined by hashing an empty string', () => {
      // Empty string hash -> e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      const hashUndefined = hashStringSHA256(undefined as any);
      const hashEmpty = hashStringSHA256('');
      expect(hashUndefined).toBe(hashEmpty);
      expect(hashUndefined).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles null by hashing an empty string', () => {
      const hashNull = hashStringSHA256(null as any);
      const hashEmpty = hashStringSHA256('');
      expect(hashNull).toBe(hashEmpty);
    });
  });
});
