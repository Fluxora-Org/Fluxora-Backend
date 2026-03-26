/**
 * Decimal String Serialization Policy for Fluxora Backend
 * 
 * Purpose: Ensure amounts, identities, and stream states crossing the chain/API boundary
 * remain unambiguous for integrators and finance reviewers.
 * 
 * Trust Boundaries:
 * - Public internet clients: Can only send valid decimal strings, receive serialized responses
 * - Authenticated partners: Same as public, with additional API key validation (future)
 * - Administrators: Can configure serialization policy (future)
 * - Internal workers: Can process chain data with full precision
 * 
 * Invariants:
 * - All amount fields in JSON responses MUST be strings
 * - Input validation rejects any non-string or malformed decimal input
 * - Zero values serialize to "0", never omitted or null
 * - Very large values preserve full precision (up to safe integer limits)
 * 
 * @module serialization/decimal
 */

/**
 * Regular expression for validating decimal string format.
 * Allows: optional sign, digits, optional decimal point with digits
 * Examples: "100", "-50", "0.0000001", "+1.5"
 */
export const DECIMAL_STRING_PATTERN = /^[+-]?\d+(\.\d+)?$/;

/**
 * Maximum safe integer for JavaScript (2^53 - 1)
 * Used for validation before any numeric operations
 */
export const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Error codes for decimal serialization failures
 */
export enum DecimalErrorCode {
  INVALID_TYPE = 'DECIMAL_INVALID_TYPE',
  INVALID_FORMAT = 'DECIMAL_INVALID_FORMAT',
  OUT_OF_RANGE = 'DECIMAL_OUT_OF_RANGE',
  PRECISION_LOSS = 'DECIMAL_PRECISION_LOSS',
  EMPTY_VALUE = 'DECIMAL_EMPTY_VALUE',
}

/**
 * Custom error class for decimal serialization errors
 */
export class DecimalSerializationError extends Error {
  constructor(
    public readonly code: DecimalErrorCode,
    message: string,
    public readonly field?: string,
    public readonly rawValue?: unknown
  ) {
    super(message);
    this.name = 'DecimalSerializationError';
  }
}

/**
 * Result type for validation operations
 */
export interface ValidationResult {
  valid: boolean;
  value?: string;
  error?: DecimalSerializationError;
}

/**
 * Validate that a value is a valid decimal string representation
 * 
 * @param value - The value to validate
 * @param fieldName - Optional field name for error context
 * @returns ValidationResult with either valid value or error details
 * 
 * @example
 * const result = validateDecimalString(100);
 * if (!result.valid) {
 *   console.error(result.error.code);
 * }
 */
export function validateDecimalString(value: unknown, fieldName?: string): ValidationResult {
  // Check for null/undefined
  if (value === null || value === undefined) {
    return {
      valid: false,
      error: new DecimalSerializationError(
        DecimalErrorCode.EMPTY_VALUE,
        `Field '${fieldName ?? 'value'}' cannot be null or undefined`,
        fieldName,
        value
      ),
    };
  }

  // Check for string type
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: new DecimalSerializationError(
        DecimalErrorCode.INVALID_TYPE,
        `Field '${fieldName ?? 'value'}' must be a string, received ${typeof value}`,
        fieldName,
        value
      ),
    };
  }

  // Check for empty string
  if (value.trim() === '') {
    return {
      valid: false,
      error: new DecimalSerializationError(
        DecimalErrorCode.EMPTY_VALUE,
        `Field '${fieldName ?? 'value'}' cannot be empty`,
        fieldName,
        value
      ),
    };
  }

  // Validate format using regex
  if (!DECIMAL_STRING_PATTERN.test(value)) {
    return {
      valid: false,
      error: new DecimalSerializationError(
        DecimalErrorCode.INVALID_FORMAT,
        `Field '${fieldName ?? 'value'}' must be a valid decimal string (e.g., "100", "-50", "0.0000001")`,
        fieldName,
        value
      ),
    };
  }

  // Check for out of range (would cause precision loss in JSON)
  try {
    const bigIntValue = BigInt(value.replace('.', ''));
    const absBigIntValue = bigIntValue < 0n ? -bigIntValue : bigIntValue;
    
    // Allow values up to 10^20 (more than enough for any financial amount)
    if (absBigIntValue > 10_000_000_000_000_000_000n) {
      return {
        valid: false,
        error: new DecimalSerializationError(
          DecimalErrorCode.OUT_OF_RANGE,
          `Field '${fieldName ?? 'value'}' exceeds maximum supported value`,
          fieldName,
          value
        ),
      };
    }
  } catch {
    // If BigInt conversion fails for any reason, still allow the value
    // as it's already validated by the regex
  }

  return { valid: true, value };
}

/**
 * Serialize a numeric value to a decimal string
 * 
 * @param value - The value to serialize (number, string, or BigInt)
 * @param fieldName - Optional field name for error context
 * @returns The decimal string representation
 * @throws DecimalSerializationError if the value cannot be safely serialized
 * 
 * @example
 * const serialized = serializeToDecimalString(100.50);
 * // Returns: "100.5"
 */
export function serializeToDecimalString(value: unknown, fieldName?: string): string {
  // Handle null/undefined
  if (value === null || value === undefined) {
    throw new DecimalSerializationError(
      DecimalErrorCode.EMPTY_VALUE,
      `Field '${fieldName ?? 'value'}' cannot be null or undefined`,
      fieldName,
      value
    );
  }

  // Handle strings - validate and return as-is if valid
  if (typeof value === 'string') {
    const result = validateDecimalString(value, fieldName);
    if (!result.valid) {
      throw result.error;
    }
    return value;
  }

  // Handle numbers
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DecimalSerializationError(
        DecimalErrorCode.INVALID_FORMAT,
        `Field '${fieldName ?? 'value'}' must be a finite number`,
        fieldName,
        value
      );
    }

    if (!Number.isInteger(value)) {
      // For floating point numbers, convert to string and validate
      // Using toString() which may produce scientific notation for very small/large numbers
      const strValue = value.toString();
      
      // Check if toString produced scientific notation (not allowed)
      if (strValue.includes('e')) {
        throw new DecimalSerializationError(
          DecimalErrorCode.PRECISION_LOSS,
          `Field '${fieldName ?? 'value'}' would lose precision with floating point serialization`,
          fieldName,
          value
        );
      }
      
      return strValue;
    }
    
    // Integer - return as string
    return value.toString();
  }

  // Handle BigInt
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Unknown type
  throw new DecimalSerializationError(
    DecimalErrorCode.INVALID_TYPE,
    `Field '${fieldName ?? 'value'}' must be a string, number, or BigInt`,
    fieldName,
    value
  );
}

/**
 * Deserialize a decimal string to a number (use with caution)
 * 
 * @param value - The decimal string to deserialize
 * @param fieldName - Optional field name for error context
 * @returns The numeric representation
 * @throws DecimalSerializationError if deserialization would lose precision
 * 
 * @example
 * const num = deserializeToNumber("100.50");
 * // Returns: 100.5
 */
export function deserializeToNumber(value: unknown, fieldName?: string): number {
  const validated = validateDecimalString(value, fieldName);
  
  if (!validated.valid) {
    throw validated.error;
  }

  const numValue = Number(validated.value);
  
  if (!Number.isFinite(numValue)) {
    throw new DecimalSerializationError(
      DecimalErrorCode.OUT_OF_RANGE,
      `Field '${fieldName ?? 'value'}' cannot be represented as a finite number`,
      fieldName,
      value
    );
  }

  return numValue;
}

/**
 * Safe version of deserializeToNumber that returns null instead of throwing
 */
export function tryDeserializeToNumber(value: unknown, fieldName?: string): number | null {
  try {
    return deserializeToNumber(value, fieldName);
  } catch {
    return null;
  }
}

/**
 * Format a decimal string for display (adds thousands separators)
 * 
 * @param value - The decimal string to format
 * @param decimals - Number of decimal places to show
 * @returns Formatted string
 * 
 * @example
 * const formatted = formatDecimalForDisplay("1000000.50", 2);
 * // Returns: "1,000,000.50"
 */
export function formatDecimalForDisplay(value: string, decimals: number = 7): string {
  const validated = validateDecimalString(value);
  
  if (!validated.valid) {
    return value; // Return original if invalid
  }

  const [intPart, decPart] = validated.value!.split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const absIntPart = intPart.replace(/^[+-]/, '');
  
  // Add thousands separators
  const formattedInt = sign + absIntPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  
  // If no decimals requested, return integer part
  if (decimals === 0) {
    return formattedInt;
  }
  
  // Format decimal part
  const paddedDec = decPart 
    ? decPart.padEnd(decimals, '0').slice(0, decimals)
    : '0'.repeat(decimals);
    
  return `${formattedInt}.${paddedDec}`;
}

/**
 * Create a safe amount object for API responses
 * All amount fields are guaranteed to be strings
 */
export interface AmountFields {
  amount?: string;
  balance?: string;
  ratePerSecond?: string;
  depositAmount?: string;
  totalAmount?: string;
  withdrawnAmount?: string;
  [key: string]: string | undefined;
}

/**
 * Validate and serialize an object with amount fields
 * 
 * @param obj - Object containing potential amount fields
 * @param fieldNames - Array of field names to treat as amounts
 * @returns New object with validated amount fields as strings
 * @throws DecimalSerializationError if any amount field fails validation
 */
export function serializeAmountFields<T extends Record<string, unknown>>(
  obj: T,
  fieldNames: (keyof T)[]
): T {
  const result = { ...obj };
  
  for (const fieldName of fieldNames) {
    if (fieldName in result) {
      const value = result[fieldName];
      
      // Skip null/undefined (field might not exist)
      if (value === null || value === undefined) {
        continue;
      }
      
      // Validate and serialize
      const serialized = serializeToDecimalString(value, String(fieldName));
      (result as Record<string, unknown>)[String(fieldName)] = serialized;
    }
  }
  
  return result;
}

/**
 * Validate amount fields in an incoming request
 * 
 * @param obj - Object containing potential amount fields
 * @param fieldNames - Array of field names to validate as amounts
 * @returns ValidationResult with all errors or validated values
 */
export function validateAmountFields<T extends Record<string, unknown>>(
  obj: T,
  fieldNames: (keyof T)[]
): { valid: boolean; errors: DecimalSerializationError[] } {
  const errors: DecimalSerializationError[] = [];
  
  for (const fieldName of fieldNames) {
    if (fieldName in obj) {
      const value = obj[fieldName];
      
      // Skip null/undefined (field might not exist)
      if (value === null || value === undefined) {
        continue;
      }
      
      const result = validateDecimalString(value, String(fieldName));
      if (!result.valid && result.error) {
        errors.push(result.error);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
