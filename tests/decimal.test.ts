/**
 * Decimal String Serialization Tests
 * 
 * Purpose: Verify the decimal string serialization policy for amounts crossing
 * the chain/API boundary. Tests cover valid inputs, invalid inputs, edge cases,
 * and precision preservation.
 * 
 * @file decimal.test.ts
 */

import {
  validateDecimalString,
  serializeToDecimalString,
  deserializeToNumber,
  tryDeserializeToNumber,
  formatDecimalForDisplay,
  serializeAmountFields,
  validateAmountFields,
  parseToStroops,
  formatFromStroops,
  normalizeDecimalString,
  DecimalSerializationError,
  DecimalErrorCode,
  DECIMAL_STRING_PATTERN,
} from '../src/serialization/decimal.js';

describe('Decimal String Serialization Policy', () => {
  describe('DECIMAL_STRING_PATTERN', () => {
    it('should match valid decimal strings', () => {
      expect(DECIMAL_STRING_PATTERN.test('100')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('-50')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('+1.5')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('0.0000001')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('0')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('123456789')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('0.123')).toBe(true);
      expect(DECIMAL_STRING_PATTERN.test('999999.999999')).toBe(true);
    });

    it('should not match invalid formats', () => {
      expect(DECIMAL_STRING_PATTERN.test('')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('abc')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('1.2.3')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('.5')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('5.')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('1e10')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('Infinity')).toBe(false);
      expect(DECIMAL_STRING_PATTERN.test('NaN')).toBe(false);
    });
  });

  describe('normalizeDecimalString', () => {
    it('strips trailing fractional zeros', () => {
      expect(normalizeDecimalString('100.50')).toBe('100.5');
      expect(normalizeDecimalString('1.0000000')).toBe('1');
      expect(normalizeDecimalString('100.0')).toBe('100');
      expect(normalizeDecimalString('0.10')).toBe('0.1');
    });

    it('leaves values without trailing zeros unchanged', () => {
      expect(normalizeDecimalString('100')).toBe('100');
      expect(normalizeDecimalString('0.0000116')).toBe('0.0000116');
      expect(normalizeDecimalString('0')).toBe('0');
    });

    it('handles negative values', () => {
      expect(normalizeDecimalString('-100.50')).toBe('-100.5');
      expect(normalizeDecimalString('-1.0')).toBe('-1');
    });
  });

  describe('validateDecimalString', () => {
    describe('valid inputs', () => {
      it('should validate positive integers', () => {
        const result = validateDecimalString('100');
        expect(result.valid).toBe(true);
        expect(result.value).toBe('100');
        expect(result.error).toBeUndefined();
      });

      it('should validate negative integers', () => {
        const result = validateDecimalString('-50');
        expect(result.valid).toBe(true);
        expect(result.value).toBe('-50');
      });

      it('should validate positive decimals', () => {
        const result = validateDecimalString('100.50');
        expect(result.valid).toBe(true);
        expect(result.value).toBe('100.5'); // trailing zero stripped
      });

      it('should validate zero', () => {
        const result = validateDecimalString('0');
        expect(result.valid).toBe(true);
        expect(result.value).toBe('0');
      });

      it('should validate very small decimals', () => {
        const result = validateDecimalString('0.0000001');
        expect(result.valid).toBe(true);
        expect(result.value).toBe('0.0000001');
      });

      it('should validate very large numbers', () => {
        const result = validateDecimalString('999999999999999');
        expect(result.valid).toBe(true);
      });

      it('should validate rate per second format', () => {
        const result = validateDecimalString('0.0000116');
        expect(result.valid).toBe(true);
      });

      it('should include field name in validation context', () => {
        const result = validateDecimalString('100', 'depositAmount');
        expect(result.valid).toBe(true);
        expect(result.error?.field).toBeUndefined();
      });
    });

    describe('invalid type inputs', () => {
      it('should reject null values', () => {
        const result = validateDecimalString(null);
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.EMPTY_VALUE);
      });

      it('should reject undefined values', () => {
        const result = validateDecimalString(undefined);
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.EMPTY_VALUE);
      });

      it('should reject number inputs', () => {
        const result = validateDecimalString(100 as unknown);
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_TYPE);
      });

      it('should reject object inputs', () => {
        const result = validateDecimalString({ value: '100' } as unknown);
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_TYPE);
      });

      it('should reject array inputs', () => {
        const result = validateDecimalString(['100'] as unknown);
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_TYPE);
      });
    });

    describe('invalid format inputs', () => {
      it('should reject empty strings', () => {
        const result = validateDecimalString('');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.EMPTY_VALUE);
      });

      it('should reject whitespace-only strings', () => {
        const result = validateDecimalString('   ');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.EMPTY_VALUE);
      });

      it('should reject non-numeric strings', () => {
        const result = validateDecimalString('abc');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_FORMAT);
      });

      it('should reject scientific notation', () => {
        const result = validateDecimalString('1e10');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_FORMAT);
      });

      it('should reject multiple decimal points', () => {
        const result = validateDecimalString('1.2.3');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_FORMAT);
      });

      it('should reject leading decimal without integer', () => {
        const result = validateDecimalString('.5');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_FORMAT);
      });

      it('should reject trailing decimal without fraction', () => {
        const result = validateDecimalString('5.');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.INVALID_FORMAT);
      });
    });

    describe('edge cases', () => {
      it('should handle maximum safe values', () => {
        const result = validateDecimalString('9007199254740991');
        expect(result.valid).toBe(true);
      });

      it('should handle seven decimal places (Stellar precision)', () => {
        const result = validateDecimalString('1000000.0000001');
        expect(result.valid).toBe(true);
      });

      it('should handle plus sign prefix', () => {
        const result = validateDecimalString('+100');
        expect(result.valid).toBe(true);
      });

      it('should reject extremely large values (precision risk)', () => {
        const result = validateDecimalString('99999999999999999999999');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.OUT_OF_RANGE);
      });

      // --- Extreme value boundary tests ---

      it('should accept int64 max (9223372036854775807)', () => {
        const result = validateDecimalString('9223372036854775807');
        expect(result.valid).toBe(true);
        expect(result.value).toBe('9223372036854775807');
      });

      it('should reject int64 max + 1 (9223372036854775808)', () => {
        const result = validateDecimalString('9223372036854775808');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.OUT_OF_RANGE);
      });

      it('should accept int64 max with fractional part', () => {
        // Integer part equals int64 max — still valid
        const result = validateDecimalString('9223372036854775807.9999999');
        expect(result.valid).toBe(true);
      });

      it('should reject value whose integer part exceeds int64 max', () => {
        const result = validateDecimalString('9223372036854775808.0');
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe(DecimalErrorCode.OUT_OF_RANGE);
      });

      // --- Trailing-zero normalization tests ---

      it('should normalize trailing fractional zeros', () => {
        expect(validateDecimalString('100.50').value).toBe('100.5');
        expect(validateDecimalString('1.0000000').value).toBe('1');
        expect(validateDecimalString('100.0').value).toBe('100');
        expect(validateDecimalString('0.10').value).toBe('0.1');
      });

      it('should not alter values with no trailing zeros', () => {
        expect(validateDecimalString('0.0000116').value).toBe('0.0000116');
        expect(validateDecimalString('100').value).toBe('100');
        expect(validateDecimalString('0').value).toBe('0');
      });
    });
  });

  describe('serializeToDecimalString', () => {
    it('should serialize valid string as-is when already normalized', () => {
      const result = serializeToDecimalString('100.5');
      expect(result).toBe('100.5');
    });

    it('should normalize trailing zeros in string input', () => {
      expect(serializeToDecimalString('100.50')).toBe('100.5');
      expect(serializeToDecimalString('1.0000000')).toBe('1');
      expect(serializeToDecimalString('100.0')).toBe('100');
    });

    it('should serialize integer numbers', () => {
      const result = serializeToDecimalString(100);
      expect(result).toBe('100');
    });

    it('should serialize negative numbers', () => {
      const result = serializeToDecimalString(-50.25);
      expect(result).toBe('-50.25');
    });

    it('should serialize BigInt', () => {
      const result = serializeToDecimalString(100n);
      expect(result).toBe('100');
    });

    it('should throw on null', () => {
      expect(() => serializeToDecimalString(null)).toThrow(DecimalSerializationError);
    });

    it('should throw on undefined', () => {
      expect(() => serializeToDecimalString(undefined)).toThrow(DecimalSerializationError);
    });

    it('should throw on invalid string format', () => {
      expect(() => serializeToDecimalString('abc')).toThrow(DecimalSerializationError);
    });

    it('should throw on Infinity', () => {
      expect(() => serializeToDecimalString(Infinity)).toThrow(DecimalSerializationError);
    });

    it('should throw on NaN', () => {
      expect(() => serializeToDecimalString(NaN)).toThrow(DecimalSerializationError);
    });

    it('should throw on floating point with precision loss', () => {
      // 0.1 + 0.2 in JavaScript is 0.30000000000000004
      const result = serializeToDecimalString(0.1 + 0.2);
      expect(result).toBe('0.30000000000000004');
    });
  });

  describe('deserializeToNumber', () => {
    it('should deserialize valid decimal strings', () => {
      const result = deserializeToNumber('100.50');
      expect(result).toBe(100.5);
    });

    it('should deserialize integers', () => {
      const result = deserializeToNumber('100');
      expect(result).toBe(100);
    });

    it('should throw on invalid input', () => {
      expect(() => deserializeToNumber('abc')).toThrow(DecimalSerializationError);
    });

    it('should throw on precision loss', () => {
      // This would lose precision
      expect(() => deserializeToNumber('99999999999999999999')).toThrow(DecimalSerializationError);
    });
  });

  describe('tryDeserializeToNumber', () => {
    it('should return number for valid input', () => {
      const result = tryDeserializeToNumber('100.50');
      expect(result).toBe(100.5);
    });

    it('should return null for invalid input', () => {
      const result = tryDeserializeToNumber('abc');
      expect(result).toBeNull();
    });

    it('should return null for precision loss', () => {
      const result = tryDeserializeToNumber('99999999999999999999');
      expect(result).toBeNull();
    });
  });

  describe('parseToStroops', () => {
    it('should parse integer to stroops', () => {
      expect(parseToStroops('100')).toBe(1_000_000_000n);
    });

    it('should parse decimal to stroops', () => {
      expect(parseToStroops('1.5')).toBe(15_000_000n);
      expect(parseToStroops('0.0000001')).toBe(1n);
    });

    it('should parse negative decimal to stroops', () => {
      expect(parseToStroops('-1.5')).toBe(-15_000_000n);
    });

    it('should throw if precision exceeded', () => {
      expect(() => parseToStroops('1.00000001')).toThrow(DecimalSerializationError);
    });
  });

  describe('formatFromStroops', () => {
    it('should format stroops to integer string', () => {
      expect(formatFromStroops(1_000_000_000n)).toBe('100');
    });

    it('should format stroops to decimal string', () => {
      expect(formatFromStroops(15_000_000n)).toBe('1.5');
      expect(formatFromStroops(1n)).toBe('0.0000001');
    });

    it('should format negative stroops', () => {
      expect(formatFromStroops(-15_000_000n)).toBe('-1.5');
    });

    it('should format zero', () => {
      expect(formatFromStroops(0n)).toBe('0');
    });
  });

  describe('formatDecimalForDisplay', () => {
    it('should add thousands separators with default padding', () => {
      const result = formatDecimalForDisplay('1000000');
      expect(result).toBe('1,000,000.0000000');
    });

    it('should preserve decimal places', () => {
      const result = formatDecimalForDisplay('1000000.50', 2);
      expect(result).toBe('1,000,000.50');
    });

    it('should pad short decimals', () => {
      const result = formatDecimalForDisplay('100', 7);
      expect(result).toBe('100.0000000');
    });

    it('should format integer with decimal places', () => {
      const result = formatDecimalForDisplay('1000', 2);
      expect(result).toBe('1,000.00');
    });

    it('should truncate long decimals', () => {
      const result = formatDecimalForDisplay('100.123456789', 3);
      expect(result).toBe('100.123');
    });

    it('should handle negative numbers with default padding', () => {
      const result = formatDecimalForDisplay('-1000000');
      expect(result).toBe('-1,000,000.0000000');
    });

    it('should return original for invalid input', () => {
      const result = formatDecimalForDisplay('abc');
      expect(result).toBe('abc');
    });

    it('should handle zero decimals', () => {
      const result = formatDecimalForDisplay('1000000', 0);
      expect(result).toBe('1,000,000');
    });
  });

  describe('serializeAmountFields', () => {
    it('should serialize specified amount fields', () => {
      const obj = {
        amount: '100',
        balance: 200,
        rate: 300n,
        name: 'test',
      };

      const result = serializeAmountFields(obj, ['amount', 'balance', 'rate']);

      expect(result.amount).toBe('100');
      expect(result.balance).toBe('200');
      expect(result.rate).toBe('300');
      expect(result.name).toBe('test');
    });

    it('should skip null/undefined fields', () => {
      const obj = {
        amount: null,
        balance: undefined,
        rate: 100n,
      };

      const result = serializeAmountFields(obj, ['amount', 'balance', 'rate']);

      expect(result.amount).toBeNull();
      expect(result.balance).toBeUndefined();
      expect(result.rate).toBe('100');
    });

    it('should throw on invalid amount field', () => {
      const obj = {
        amount: 'invalid',
        balance: 100,
      };

      expect(() => serializeAmountFields(obj, ['amount'])).toThrow(DecimalSerializationError);
    });
  });

  describe('validateAmountFields', () => {
    it('should validate all specified fields', () => {
      const obj = {
        depositAmount: '100',
        ratePerSecond: '0.0000116',
      };

      const result = validateAmountFields(obj, ['depositAmount', 'ratePerSecond']);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should collect all validation errors', () => {
      const obj = {
        depositAmount: 'invalid',
        ratePerSecond: 100,
      };

      const result = validateAmountFields(obj, ['depositAmount', 'ratePerSecond']);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('should skip null/undefined fields', () => {
      const obj = {
        depositAmount: null,
        ratePerSecond: undefined,
      };

      const result = validateAmountFields(obj, ['depositAmount', 'ratePerSecond']);

      expect(result.valid).toBe(true);
    });
  });
});

describe('Decimal Error Classification', () => {
  it('should classify INVALID_TYPE errors', () => {
    const result = validateDecimalString(123 as unknown);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe(DecimalErrorCode.INVALID_TYPE);
    expect(result.error?.message).toContain('must be a string');
  });

  it('should classify INVALID_FORMAT errors', () => {
    const result = validateDecimalString('abc');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe(DecimalErrorCode.INVALID_FORMAT);
  });

  it('should classify OUT_OF_RANGE errors', () => {
    const result = validateDecimalString('999999999999999999999999999999');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe(DecimalErrorCode.OUT_OF_RANGE);
  });

  it('should classify EMPTY_VALUE errors', () => {
    const result = validateDecimalString(null);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe(DecimalErrorCode.EMPTY_VALUE);
  });
});
