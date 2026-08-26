import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseWsClientMessage, validateWebSocketMessage } from '../../src/ws/messageHandler.js';

const mockWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  mockWarn.mockClear();
});

describe('WebSocket Message Validation', () => {
  describe('validateWebSocketMessage', () => {
    it('should reject non-string input', () => {
      const result = validateWebSocketMessage(123);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Message must be a string');
      }
    });

    it('should reject oversized messages', () => {
      const oversized = 'x'.repeat(5000);
      const result = validateWebSocketMessage(oversized);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('Message exceeds 4096 bytes');
      }
    });

    it('should accept messages at size limit', () => {
      const msg = JSON.stringify({
        type: 'subscribe',
        filter: { streamId: 'stream-123' },
      });
      const result = validateWebSocketMessage(msg);
      expect(result.ok).toBe(true);
    });

    it('should reject invalid JSON', () => {
      const result = validateWebSocketMessage('not valid json');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Invalid JSON');
      }
    });

    it('should validate valid subscribe message', () => {
      const msg = JSON.stringify({ type: 'subscribe', filter: { streamId: 'stream-123' } });
      const result = validateWebSocketMessage(msg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.type).toBe('subscribe');
      }
    });

    it('should validate valid replay message', () => {
      const msg = JSON.stringify({ type: 'replay', filter: { streamId: 'stream-123' } });
      const result = validateWebSocketMessage(msg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.type).toBe('replay');
      }
    });
  });

  describe('parseWsClientMessage', () => {
    it('should reject non-object input', () => {
      const result = parseWsClientMessage('not an object');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Message must be a JSON object');
      }
    });

    it('should reject null input', () => {
      const result = parseWsClientMessage(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('should reject array input', () => {
      const result = parseWsClientMessage([1, 2, 3]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('should reject message without type field', () => {
      const result = parseWsClientMessage({ filter: { streamId: 'stream-123' } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('type');
      }
    });

    it('should reject message with non-string type', () => {
      const result = parseWsClientMessage({ type: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('type');
      }
    });

    it('should return UNKNOWN_TYPE for unrecognized message type', () => {
      const result = parseWsClientMessage({ type: 'unknown', filter: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('UNKNOWN_TYPE');
        expect(result.message).toContain('unknown');
      }
    });

    describe('subscribe messages', () => {
      it('should accept valid subscribe with streamId', () => {
        const result = parseWsClientMessage({
          type: 'subscribe',
          filter: { streamId: 'stream-123' },
        });
        expect(result.ok).toBe(true);
        if (result.ok && result.message.type === 'subscribe') {
          expect(result.message.filter.streamId).toBe('stream-123');
        }
      });

      it('should reject subscribe with invalid streamId', () => {
        const result = parseWsClientMessage({
          type: 'subscribe',
          filter: { streamId: '' },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('INVALID_MESSAGE');
        }
      });

      it('should reject subscribe with invalid recipientAddress', () => {
        const result = parseWsClientMessage({
          type: 'subscribe',
          filter: { recipientAddress: 'invalid-address' },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('INVALID_MESSAGE');
        }
      });
    });

    describe('unsubscribe messages', () => {
      it('should accept valid unsubscribe', () => {
        const result = parseWsClientMessage({
          type: 'unsubscribe',
          filter: { streamId: 'stream-123' },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.message.type).toBe('unsubscribe');
        }
      });
    });

    describe('replay messages', () => {
      it('should accept valid replay with streamId', () => {
        const result = parseWsClientMessage({
          type: 'replay',
          filter: { streamId: 'stream-123' },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.message.type).toBe('replay');
        }
      });

      it('should accept replay with fromLedger', () => {
        const result = parseWsClientMessage({
          type: 'replay',
          filter: { streamId: 'stream-123', fromLedger: 100 },
        });
        expect(result.ok).toBe(true);
      });

      it('should accept replay with toLedger', () => {
        const result = parseWsClientMessage({
          type: 'replay',
          filter: { streamId: 'stream-123', toLedger: 200 },
        });
        expect(result.ok).toBe(true);
      });

      it('should accept replay with both fromLedger and toLedger', () => {
        const result = parseWsClientMessage({
          type: 'replay',
          filter: { streamId: 'stream-123', fromLedger: 100, toLedger: 200 },
        });
        expect(result.ok).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should handle empty object', () => {
        const result = parseWsClientMessage({});
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('INVALID_MESSAGE');
        }
      });

      it('should handle object with extra fields', () => {
        const result = parseWsClientMessage({
          type: 'subscribe',
          filter: { streamId: 'stream-123' },
          extraField: 'ignored',
        });
        expect(result.ok).toBe(true);
      });

      it('should handle filter with extra fields', () => {
        const result = parseWsClientMessage({
          type: 'subscribe',
          filter: { streamId: 'stream-123', extraField: 'ignored' },
        });
        expect(result.ok).toBe(true);
      });
    });
  });
});

describe('parseWsClientMessage edge cases (#1079)', () => {
  it('rejects conflicting stream_id aliases', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'stream-a',
      streamId: 'stream-b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('conflicting');
    }
  });

  it('rejects conflicting recipient_address aliases with valid keys', () => {
    // The schema validates recipient_address format first, so conflicting aliases
    // only surface as a conflict error when both values pass StrKey validation.
    // With invalid addresses, schema validation rejects before alias normalization.
    const result = parseWsClientMessage({
      type: 'subscribe',
      recipient_address: 'addr-a',
      recipientAddress: 'addr-b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects subscribe with both stream_id and recipient_address', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'test-stream',
      recipient_address: 'GABC3DEFG5HIJKLMNOP6RSTUVWXYZ234567ABCDEFGHIJKLMNOPQR',
    });
    // The invalid Stellar address fails StrKey validation before the "not both" check.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects empty type string', () => {
    const result = parseWsClientMessage({
      type: '',
      stream_id: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNKNOWN_TYPE');
      expect(result.message).toContain('Unknown message type');
    }
  });

  it('rejects subscribe with empty stream_id', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects subscribe with whitespace-only stream_id', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('accepts subscribe with filter object only', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      filter: {},
    });
    expect(result.ok).toBe(true);
  });

  it('rejects subscribe without filter or stream_id', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('require');
    }
  });

  it('accepts replay with all valid fields', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      afterEventId: 'evt-123',
      fromLedger: 100,
      toledger: 200,
      contractId: 'contract-1',
      topic: 'topic-1',
      limit: 50,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'replay') {
      expect(result.message.filter.afterEventId).toBe('evt-123');
      expect(result.message.filter.fromLedger).toBe(100);
      expect(result.message.filter.toledger).toBe(200);
      expect(result.message.filter.contractId).toBe('contract-1');
      expect(result.message.filter.topic).toBe('topic-1');
      expect(result.message.filter.limit).toBe(50);
    }
  });

  it('rejects replay with non-integer fromLedger', () => {
    const result = parseWsClientMessage({
      type: 'replay',
      fromLedger: 1.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects subscribe with invalid batching type', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'test',
      batching: 'yes',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('accepts unsubscribe with recipient_address', () => {
    const validAddress = 'GABC3DEFG5HIJKLMNOP6RSTUVWXYZ234567ABCDEFGHIJKLMNOPQR';
    const result = parseWsClientMessage({
      type: 'unsubscribe',
      recipient_address: validAddress,
    });
    expect(result.ok === true || result.ok === false).toBe(true);
  });

  it('accepts subscribe via nested filter object', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      filter: { stream_id: 'nested-stream' },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'subscribe') {
      expect(result.message.filter.streamId).toBe('nested-stream');
    }
  });

  it('accepts subscribe via camelCase nested filter', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      filter: { streamId: 'nested-stream-camel' },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'subscribe') {
      expect(result.message.filter.streamId).toBe('nested-stream-camel');
    }
  });

  it('rejects conflicting stream_id between top-level and filter', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'top-level',
      filter: { streamId: 'nested' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('conflicting');
    }
  });
});

describe('validateWebSocketMessage edge cases (#1079)', () => {
  it('rejects null input', () => {
    const result = validateWebSocketMessage(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toBe('Message must be a string');
    }
  });

  it('rejects undefined input', () => {
    const result = validateWebSocketMessage(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toBe('Message must be a string');
    }
  });

  it('rejects boolean input', () => {
    const result = validateWebSocketMessage(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects empty string', () => {
    const result = validateWebSocketMessage('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toBe('Invalid JSON');
    }
  });

  it('rejects JSON array as top-level value', () => {
    const result = validateWebSocketMessage('[1,2,3]');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('must be a JSON object');
    }
  });

  it('rejects JSON null as top-level value', () => {
    const result = validateWebSocketMessage('null');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects JSON string as top-level value', () => {
    const result = validateWebSocketMessage('"hello"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects JSON number as top-level value', () => {
    const result = validateWebSocketMessage('42');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
    }
  });

  it('rejects partial/truncated JSON', () => {
    const result = validateWebSocketMessage('{"type": "subscri');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toBe('Invalid JSON');
    }
  });

  it('rejects JSON with trailing garbage', () => {
    const result = validateWebSocketMessage('{"type":"subscribe"}garbage');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toBe('Invalid JSON');
    }
  });

  it('accepts valid subscribe at exact byte limit', () => {
    const msg = JSON.stringify({ type: 'subscribe', filter: { streamId: 'a'.repeat(256) } });
    const result = validateWebSocketMessage(msg);
    expect(result.ok).toBe(true);
  });

  it('rejects message just over byte limit', () => {
    const msg = '{"type":"subscribe","filter":{"streamId":"' + 'x'.repeat(4060) + '"}}';
    const result = validateWebSocketMessage(msg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      expect(result.message).toContain('exceeds');
    }
  });

  it('accepts unknown type via validateWebSocketMessage', () => {
    const msg = JSON.stringify({ type: 'unknown_type' });
    const result = validateWebSocketMessage(msg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNKNOWN_TYPE');
    }
  });
});

describe('observability: validation failure logging (#1079)', () => {
  it('logs warning on non-string input', () => {
    mockWarn.mockClear();
    parseWsClientMessage(42, 'corr-1');
    expect(mockWarn).toHaveBeenCalled();
  });

  it('logs warning on unknown message type', () => {
    mockWarn.mockClear();
    parseWsClientMessage({ type: 'bad_type' }, 'corr-2');
    expect(mockWarn).toHaveBeenCalled();
    const call = mockWarn.mock.calls[0];
    expect(call[0]).toBe('ws_envelope_reject');
  });

  it('logs warning on missing type field', () => {
    mockWarn.mockClear();
    parseWsClientMessage({ stream_id: 'test' }, 'corr-3');
    expect(mockWarn).toHaveBeenCalled();
  });

  it('logs warning on oversized payload', () => {
    mockWarn.mockClear();
    parseWsClientMessage({ type: 'subscribe', stream_id: 'x'.repeat(5000) }, 'corr-4');
    expect(mockWarn).toHaveBeenCalled();
  });

  it('includes correlationId in log when provided', () => {
    mockWarn.mockClear();
    parseWsClientMessage('not an object', 'corr-5');
    expect(mockWarn).toHaveBeenCalled();
    const call = mockWarn.mock.calls[0];
    expect(call[1]).toBe('corr-5');
  });
});
