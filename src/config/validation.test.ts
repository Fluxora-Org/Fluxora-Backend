import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateStellarAddress } from './validation.js';

describe('validation config', () => {
  it('should validate stellar address', () => {
    // Valid 56-char Stellar G-address (no 0, 1, 8, 9)
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const validated = validateStellarAddress(address);
    assert.strictEqual(validated, address);
  });
});
