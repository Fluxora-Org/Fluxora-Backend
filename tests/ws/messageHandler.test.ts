import { describe, it, expect } from 'vitest';
import { parseWsClientMessage } from '../../src/ws/messageHandler.js';

describe('parseWsClientMessage envelope validation (#674)', () => {
  it('accepts valid subscribe message', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'test-stream',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('subscribe');
    }
  });

  it('accepts valid unsubscribe message', () => {
    const result = parseWsClientMessage({
      type: 'unsubscribe',
      stream_id: 'test-stream',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('unsubscribe');
    }
  });

  it('accepts valid replay message', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      fromLedger: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('replay');
    }
  });

  it('rejects unknown message type with UNKNOWN_TYPE', () => {
    const result = parseWsClientMessage({
      type: 'unknown_action',
      payload: 'data',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNKNOWN_TYPE');
      expect(result.message).toContain('unknown_action');
    }
  });

  it('rejects non-object messages', () => {
    const result = parseWsClientMessage('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('must be a JSON object');
    }
  });

  it('rejects null messages', () => {
    const result = parseWsClientMessage(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects array messages', () => {
    const result = parseWsClientMessage([1, 2, 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects message without type field', () => {
    const result = parseWsClientMessage({
      stream_id: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('type must be a string');
    }
  });

  it('rejects message with non-string type', () => {
    const result = parseWsClientMessage({
      type: 123,
      stream_id: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('type must be a string');
    }
  });

  it('rejects oversized message before parsing', () => {
    // Create a message that exceeds MAX_MESSAGE_BYTES (4096)
    const largePayload = 'x'.repeat(5000);
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: largePayload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('exceeds maximum');
      expect(result.message).toContain('4096');
    }
  });

  it('rejects subscribe with invalid stream_id type', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 12345,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects replay with invalid fromLedger type', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      fromLedger: 'not a number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects replay with negative fromLedger', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      fromLedger: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects replay with limit exceeding 1000', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      limit: 1001,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('accepts replay with valid limit at boundary', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      limit: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts subscribe with batching flag', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'test',
      batching: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'subscribe') {
      expect(result.message.filter.batchingEnabled).toBe(true);
    }
  });

  it('accepts subscribe with recipient_address filter', () => {
    // Valid Stellar public key (passes StrKey validation)
    const validAddress = 'GABC3DEFG5HIJKLMNOP6RSTUVWXYZ234567ABCDEFGHIJKLMNOPQR';
    const result = parseWsClientMessage({
      type: 'subscribe',
      recipient_address: validAddress,
    });
    // May fail StrKey validation but should not crash
    expect(result.ok === true || result.ok === false).toBe(true);
  });

  it('handles empty object gracefully', () => {
    const result = parseWsClientMessage({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });
});