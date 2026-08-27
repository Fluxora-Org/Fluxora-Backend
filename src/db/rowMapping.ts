/**
 * Strict database row → domain value readers (issue #1316).
 *
 * Row mappers must never turn a missing, NULL, or wrongly-typed column into a
 * plausible-looking default. `Number(null)` is `0`, `Number([])` is `0`, and
 * `new Date(String(undefined))` is an Invalid Date that survives every
 * downstream comparison — each of those silently converts a corrupt row into a
 * valid-looking domain object.
 *
 * Every reader here fails loudly with a {@link RowMappingError} that names the
 * table, the column, and why the value was rejected. The nullability contract
 * is taken from the migration that owns the table, not from the domain
 * interface: a column is read with `optional*` if and only if its column
 * definition omits `notNull: true`.
 *
 * Callers choose the failure policy:
 *  - Request-serving read paths let the error propagate (fail fast) — returning
 *    a cursor whose `total_rows` silently became 0 is worse than a 500.
 *  - Background collectors catch it per row, skip the row, and keep the
 *    interval alive (quarantine).
 */

/** Inclusive bounds of PostgreSQL `integer` (int4). */
export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

/**
 * Widest value a PostgreSQL `bigint` column can hold without losing precision
 * once it reaches JavaScript. `bigint` itself goes further; anything past this
 * point is rejected rather than silently rounded.
 */
export const BIGINT_SAFE_MAX = Number.MAX_SAFE_INTEGER;

export const ROW_MAPPING_ERROR_CODE = 'ROW_MAPPING_INVALID';

/**
 * Thrown when a database row violates the nullability or type contract of the
 * table it came from.
 */
export class RowMappingError extends Error {
  public readonly code = ROW_MAPPING_ERROR_CODE;

  constructor(
    /** Table the row was read from, e.g. `replay_cursors`. */
    public readonly table: string,
    /** Offending column name as it appears in the schema. */
    public readonly column: string,
    /** Why the value was rejected. */
    public readonly reason: string,
    /**
     * Safe descriptor of what was received. Never the raw value — rows can
     * carry PII and this string reaches logs.
     */
    public readonly received: string,
  ) {
    super(`${table}.${column}: ${reason} (received ${received})`);
    this.name = 'RowMappingError';
  }
}

/**
 * Describe a value for an error message without leaking its contents.
 *
 * Emits a type tag plus the few properties needed to debug the rejection
 * (string length, NaN-ness, Invalid Date) and nothing else.
 */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string(length=${value.length})`;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number(NaN)';
    if (!Number.isFinite(value)) return 'number(Infinity)';
    return 'number';
  }
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Date(Invalid Date)' : 'Date';
  }
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/** Bounds applied to an integer column after type validation. */
export interface IntegerBounds {
  /** Inclusive lower bound. Defaults to {@link INT32_MIN}. */
  min?: number;
  /** Inclusive upper bound. Defaults to {@link INT32_MAX}. */
  max?: number;
}

/** Options for reading a text column. */
export interface StringOptions {
  /**
   * Whether `''` is a legal value. Defaults to `false`: a NOT NULL text column
   * holding an empty identifier is corrupt in exactly the way this module
   * exists to catch.
   */
  allowEmpty?: boolean;
}

/**
 * `pg` returns `integer` as a JS number and `bigint` as a decimal string.
 * Only those two shapes are accepted — deliberately no `1e3`, no `0x10`, no
 * `'42.5'`, no whitespace padding.
 */
const INTEGER_STRING = /^[+-]?\d+$/;

/** Column readers bound to one table and one row. */
export interface RowReader {
  requireString(column: string, options?: StringOptions): string;
  optionalString(column: string, options?: StringOptions): string | null;
  requireInt(column: string, bounds?: IntegerBounds): number;
  optionalInt(column: string, bounds?: IntegerBounds): number | null;
  requireDate(column: string): Date;
  optionalDate(column: string): Date | null;
  requireJsonObject(column: string): Record<string, unknown>;
}

/**
 * Bind the strict readers to a single row.
 *
 * ```ts
 * const r = rowReader('replay_cursors', row);
 * const ledger = r.requireInt('ledger', { min: 0 });
 * ```
 *
 * A column that is absent from the row object is treated exactly like an
 * explicit NULL: `optional*` yields `null`, `require*` throws. A `SELECT` that
 * forgot a column is a bug, and it must not be indistinguishable from a row
 * that legitimately holds NULL.
 */
export function rowReader(table: string, row: Record<string, unknown>): RowReader {
  const fail = (column: string, reason: string, value: unknown): never => {
    throw new RowMappingError(table, column, reason, describeValue(value));
  };

  const isAbsent = (value: unknown): boolean => value === null || value === undefined;

  const readString = (column: string, value: unknown, options: StringOptions): string => {
    if (typeof value !== 'string') {
      return fail(column, 'expected a string', value);
    }
    if (!options.allowEmpty && value.length === 0) {
      return fail(column, 'expected a non-empty string', value);
    }
    return value;
  };

  const readInt = (column: string, value: unknown, bounds: IntegerBounds): number => {
    const min = bounds.min ?? INT32_MIN;
    const max = bounds.max ?? INT32_MAX;

    let parsed: number;

    if (typeof value === 'number') {
      // Rejects NaN and ±Infinity, which `Number.isInteger` already excludes,
      // and 1.5, which a bare `Number()` would have passed through untouched.
      if (!Number.isInteger(value)) {
        return fail(column, 'expected an integer', value);
      }
      parsed = value;
    } else if (typeof value === 'string') {
      if (!INTEGER_STRING.test(value)) {
        return fail(column, 'expected a decimal integer string', value);
      }
      parsed = Number(value);
      // A bigint column can exceed the double-precision integer range, where
      // Number() rounds silently: Number('9007199254740993') === 9007199254740992.
      if (!Number.isSafeInteger(parsed)) {
        return fail(column, 'value exceeds the safe integer range', value);
      }
    } else {
      // Everything else — booleans, Dates, arrays, objects, bigints — would be
      // coerced by `Number()` into a number that looks fine. `Number(true)` is
      // 1, `Number([])` is 0, `Number(new Date())` is a timestamp.
      return fail(column, 'expected a number or a decimal integer string', value);
    }

    if (parsed < min || parsed > max) {
      return fail(column, `expected an integer within [${min}, ${max}]`, value);
    }
    return parsed;
  };

  const readDate = (column: string, value: unknown): Date => {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        return fail(column, 'expected a valid Date', value);
      }
      return value;
    }
    if (typeof value === 'string') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return fail(column, 'expected a parseable timestamp string', value);
      }
      return parsed;
    }
    return fail(column, 'expected a Date or a timestamp string', value);
  };

  return {
    requireString(column, options = {}) {
      const value = row[column];
      if (isAbsent(value)) {
        return fail(column, 'required column was NULL or absent', value);
      }
      return readString(column, value, options);
    },

    optionalString(column, options = {}) {
      const value = row[column];
      if (isAbsent(value)) return null;
      return readString(column, value, options);
    },

    requireInt(column, bounds = {}) {
      const value = row[column];
      if (isAbsent(value)) {
        return fail(column, 'required column was NULL or absent', value);
      }
      return readInt(column, value, bounds);
    },

    optionalInt(column, bounds = {}) {
      const value = row[column];
      if (isAbsent(value)) return null;
      return readInt(column, value, bounds);
    },

    requireDate(column) {
      const value = row[column];
      if (isAbsent(value)) {
        return fail(column, 'required column was NULL or absent', value);
      }
      return readDate(column, value);
    },

    optionalDate(column) {
      const value = row[column];
      if (isAbsent(value)) return null;
      return readDate(column, value);
    },

    requireJsonObject(column) {
      const value = row[column];
      // A `jsonb` column holding the JSON literal `null` arrives as JS `null`,
      // indistinguishable from SQL NULL. Both mean the payload is missing.
      if (isAbsent(value)) {
        return fail(column, 'required JSON column was NULL or absent', value);
      }
      if (Array.isArray(value)) {
        return fail(column, 'expected a JSON object, not an array', value);
      }
      if (typeof value !== 'object') {
        // `jsonb` accepts bare scalars, but every payload this codebase maps is
        // a keyed object. A scalar means the writer stored the wrong shape.
        // Strings are rejected too: `pg` already parses `json`/`jsonb`, so a
        // string here is an unparsed value, and parsing it would be exactly the
        // kind of silent repair this module exists to prevent.
        return fail(column, 'expected a JSON object', value);
      }
      if (value instanceof Date) {
        return fail(column, 'expected a JSON object', value);
      }
      return value as Record<string, unknown>;
    },
  };
}
