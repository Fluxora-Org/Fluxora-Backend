import { describe, it, expect } from 'vitest';
import { validateWebSocketMessage, parseWsClientMessage } from '../../src/ws/messageHandler.js';

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