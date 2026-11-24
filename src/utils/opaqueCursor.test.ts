import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decodeCursor,
  encodeCursor,
  INVALID_CURSOR_MESSAGE,
  parseCursorParam,
} from './opaqueCursor.js';

function expectInvalidCursor(fn: () => unknown): void {
  try {
    fn();
    throw new Error('Expected cursor decoding to throw');
  } catch (error) {
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: INVALID_CURSOR_MESSAGE,
    });
  }
}

describe('opaqueCursor', () => {
  it('round-trips an encoded cursor', () => {
    const cursor = encodeCursor('stream-123', 'status=active&tenant=acct-1');

    expect(decodeCursor(cursor)).toEqual({
      v: 1,
      lastId: 'stream-123',
      scope: 'status=active&tenant=acct-1',
    });
  });

  it('round-trips generated lastId and scope values', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((value) => value.trim().length > 0),
        fc.string({ maxLength: 500 }),
        (lastId, scope) => {
          expect(decodeCursor(encodeCursor(lastId, scope))).toEqual({
            v: 1,
            lastId,
            scope,
          });
        },
      ),
    );
  });

  it('rejects bad base64url and malformed JSON', () => {
    expectInvalidCursor(() => decodeCursor('not-valid-json%%%'));
  });

  it('rejects a wrong cursor version', () => {
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, lastId: 'stream-123', scope: 'scope-a' }), 'utf8')
      .toString('base64url');

    expectInvalidCursor(() => decodeCursor(wrongVersion));
  });

  it('rejects a tampered cursor payload with the documented error', () => {
    const tampered = Buffer.from(JSON.stringify({ v: 1, lastId: '', scope: 'scope-a' }), 'utf8')
      .toString('base64url');

    expectInvalidCursor(() => decodeCursor(tampered));
  });

  it('detects a scope mismatch after decoding', () => {
    const cursor = decodeCursor(encodeCursor('stream-123', 'status=active&tenant=acct-1'));

    expect(cursor.scope).not.toBe('status=paused&tenant=acct-1');
  });

  it('rejects oversized lastId and scope values', () => {
    const oversizedLastId = Buffer.from(JSON.stringify({ v: 1, lastId: 'x'.repeat(201) }), 'utf8')
      .toString('base64url');
    const oversizedScope = Buffer.from(JSON.stringify({ v: 1, lastId: 'stream-123', scope: 'x'.repeat(501) }), 'utf8')
      .toString('base64url');

    expectInvalidCursor(() => decodeCursor(oversizedLastId));
    expectInvalidCursor(() => decodeCursor(oversizedScope));
  });

  it('returns undefined only for an absent cursor parameter', () => {
    expect(parseCursorParam(undefined)).toBeUndefined();
  });

  it('rejects arrays, non-strings, and blank cursor parameters', () => {
    expectInvalidCursor(() => parseCursorParam([]));
    expectInvalidCursor(() => parseCursorParam(123));
    expectInvalidCursor(() => parseCursorParam('   '));
  });
});
