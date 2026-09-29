/**
 * Opaque keyset-pagination cursors shared by paginated routes.
 *
 * A cursor is base64url-encoded JSON `{ v: 1, lastId, scope? }`. Clients must
 * treat it as a black box; only the server produces them. `scope` optionally
 * binds a cursor to the query (filters, caller, sort order) that issued it so
 * a cursor cannot be replayed against a different query.
 *
 * Every decode failure surfaces as the same 400 VALIDATION_ERROR message so
 * the response never reveals which structural check failed.
 *
 * @module utils/opaqueCursor
 */
import { validationError } from '../middleware/errorHandler.js';
import { warn } from '../lib/logger.js';

export type OpaqueCursor = { v: 1; lastId: string; scope?: string };

export const INVALID_CURSOR_MESSAGE = 'cursor must be a valid opaque pagination token';

/** Maximum permitted length for the `lastId` field inside a decoded cursor payload. */
const CURSOR_LAST_ID_MAX_LENGTH = 200;
const CURSOR_SCOPE_MAX_LENGTH = 500;

export function encodeCursor(lastId: string, scope: string): string {
  const payload: OpaqueCursor = { v: 1, lastId, scope };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, requestId?: string): OpaqueCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (err) {
    warn('Cursor decode failed', { error: err instanceof Error ? err.message : String(err), requestId });
    throw validationError(INVALID_CURSOR_MESSAGE);
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    !('v' in parsed) || !('lastId' in parsed) ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { lastId?: unknown }).lastId !== 'string' ||
    (parsed as { lastId: string }).lastId.trim() === ''
  ) {
    warn('Cursor payload invalid', { parsed, requestId });
    throw validationError(INVALID_CURSOR_MESSAGE);
  }
  const candidate = parsed as OpaqueCursor;
  if (candidate.lastId.length > CURSOR_LAST_ID_MAX_LENGTH) {
    warn('Cursor lastId exceeds maximum length', { length: candidate.lastId.length, requestId });
    throw validationError(INVALID_CURSOR_MESSAGE);
  }
  if (
    candidate.scope !== undefined &&
    (typeof candidate.scope !== 'string' || candidate.scope.length > CURSOR_SCOPE_MAX_LENGTH)
  ) {
    throw validationError(INVALID_CURSOR_MESSAGE);
  }
  return candidate;
}

/**
 * Decode an untrusted cursor query parameter. Returns `undefined` when the
 * parameter is absent; rejects arrays, non-strings and blank strings.
 */
export function parseCursorParam(cursorParam: unknown, requestId?: string): OpaqueCursor | undefined {
  if (cursorParam === undefined) return undefined;
  if (Array.isArray(cursorParam) || typeof cursorParam !== 'string' || cursorParam.trim() === '') {
    warn('Cursor shape invalid (not a string)', { cursorParam, requestId });
    throw validationError(INVALID_CURSOR_MESSAGE);
  }
  return decodeCursor(cursorParam, requestId);
}
