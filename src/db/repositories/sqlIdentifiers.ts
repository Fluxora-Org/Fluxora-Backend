/**
 * SQL identifier allowlisting.
 *
 * PostgreSQL parameters can represent values, but not identifiers such as
 * column names or sort directions. Any identifier that is allowed to affect
 * query construction must therefore be selected from a closed, compile-time
 * allowlist before it is interpolated into SQL.
 */

export class InvalidSqlIdentifierError extends Error {
  constructor(identifier: string, kind: string) {
    super(`Invalid ${kind}: ${identifier}`);
    this.name = 'InvalidSqlIdentifierError';
  }
}

export function allowlistedSqlIdentifier<T extends string>(
  value: string,
  allowlist: Readonly<Record<T, string>>,
  kind = 'SQL identifier'
): string {
  const selected = allowlist[value as T];
  if (selected === undefined) {
    throw new InvalidSqlIdentifierError(value, kind);
  }
  return selected;
}

export const STREAM_CURSOR_SORT_FIELDS = {
  id: 'id',
} as const;

export const STREAM_OFFSET_SORT_FIELDS = {
  created_at: 'created_at DESC, id DESC',
  id: 'id DESC',
} as const;

export const SORT_DIRECTIONS = {
  asc: 'ASC',
  desc: 'DESC',
} as const;
