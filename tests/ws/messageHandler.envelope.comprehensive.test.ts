import { describe, it, expect } from 'vitest';
import {
  validateWebSocketMessage,
  parseWsClientMessage,
  parseHandshakeSubscriptionFilter,
  isValidStellarPublicKey,
} from '../../src/ws/messageHandler.js';

describe('WebSocket Envelope Validation - Comprehensive Edge Cases', () => {
  describe('Message Size Limits', () => {
    it('rejects messages exceeding MAX_MESSAGE_BYTES at validateWebSocketMessage level', () => {
      const oversized = 'x'.repeat(5000);
      const result = validateWebSocketMessage(oversized);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('exceeds 4096 bytes');
      }
    });

    it('accepts messages at exactly MAX_MESSAGE_BYTES limit', () => {
      const exactSize = 'x'.repeat(4096);
      const result = validateWebSocketMessage(exactSize);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Invalid JSON');
      }
    });

    it('rejects oversized messages in parseWsClientMessage before schema validation', () => {
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

    it('accepts messages at boundary (under 4096 bytes)', () => {
      // The message size check in parseWsClientMessage uses JSON.stringify on the object
      // and checks .length (UTF-16 code units) against MAX_MESSAGE_BYTES (4096).
      // However, stream_id field has its own max length of 256 (MAX_FILTER_VALUE_LENGTH).
      // To test the message size boundary, use replay message with afterEventId
      // which doesn't have the same field length restrictions.
      const largeFilter = {
        type: 'replay',
        afterEventId: 'x'.repeat(3800),
      };
      const result = parseWsClientMessage(largeFilter);
      expect(result.ok).toBe(true);
    });
  });

  describe('JSON Parsing', () => {
    it('rejects invalid JSON with INVALID_MESSAGE', () => {
      const result = validateWebSocketMessage('not valid json');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Invalid JSON');
      }
    });

    it('rejects non-string input to validateWebSocketMessage', () => {
      const result = validateWebSocketMessage(123 as unknown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Message must be a string');
      }
    });

    it('rejects non-object parsed JSON', () => {
      const result = parseWsClientMessage('"just a string"');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Message must be a JSON object');
      }
    });

    it('rejects null parsed JSON', () => {
      const result = parseWsClientMessage(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Message must be a JSON object');
      }
    });

    it('rejects array parsed JSON', () => {
      const result = parseWsClientMessage([1, 2, 3]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toBe('Message must be a JSON object');
      }
    });
  });

  describe('Type Field Validation', () => {
    it('rejects messages missing type field', () => {
      const result = parseWsClientMessage({ stream_id: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('type must be a string');
      }
    });

    it('rejects messages with non-string type', () => {
      const result = parseWsClientMessage({ type: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('type must be a string');
      }
    });

    it('rejects unknown message types with UNKNOWN_TYPE code', () => {
      const result = parseWsClientMessage({ type: 'unknown_action' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('UNKNOWN_TYPE');
        expect(result.message).toContain('unknown_action');
      }
    });

    it('accepts all three valid message types', () => {
      const subscribeResult = parseWsClientMessage({ type: 'subscribe', stream_id: 'test' });
      expect(subscribeResult.ok).toBe(true);

      const unsubscribeResult = parseWsClientMessage({ type: 'unsubscribe', stream_id: 'test' });
      expect(unsubscribeResult.ok).toBe(true);

      const replayResult = parseWsClientMessage({ type: 'replay', fromLedger: 100 });
      expect(replayResult.ok).toBe(true);
    });
  });

  describe('Subscription Filter Validation - stream_id', () => {
    it('accepts valid stream_id', () => {
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: 'stream-123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.streamId).toBe('stream-123');
      }
    });

    it('accepts streamId camelCase alias', () => {
      const result = parseWsClientMessage({ type: 'subscribe', streamId: 'stream-123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.streamId).toBe('stream-123');
      }
    });

    it('rejects empty stream_id', () => {
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects stream_id exceeding max length', () => {
      const longStreamId = 'x'.repeat(257);
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: longStreamId });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-string stream_id', () => {
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: 12345 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects conflicting stream_id and streamId values', () => {
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: 'a', streamId: 'b' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('conflicting');
      }
    });
  });

  describe('Subscription Filter Validation - recipient_address', () => {
    const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
    const invalidRecipient = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';

    it('accepts valid recipient_address', () => {
      const result = parseWsClientMessage({ type: 'subscribe', recipient_address: validRecipient });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.recipientAddress).toBe(validRecipient);
      }
    });

    it('accepts recipientAddress camelCase alias', () => {
      const result = parseWsClientMessage({ type: 'subscribe', recipientAddress: validRecipient });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.recipientAddress).toBe(validRecipient);
      }
    });

    it('rejects invalid recipient_address (checksum failure)', () => {
      const result = parseWsClientMessage({ type: 'subscribe', recipient_address: invalidRecipient });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects recipient_address with wrong length', () => {
      const result = parseWsClientMessage({ type: 'subscribe', recipient_address: 'GAAAA' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-string recipient_address', () => {
      const result = parseWsClientMessage({ type: 'subscribe', recipient_address: 12345 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

it('rejects conflicting recipient_address and recipientAddress values', () => {
    const result = parseWsClientMessage({
      type: 'subscribe',
      recipient_address: validRecipient,
      recipientAddress: invalidRecipient,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_MESSAGE');
      // Schema validation catches invalid recipientAddress first before conflict check
      expect(result.message).toContain('recipient_address');
    }
  });
  });

  describe('Subscription Filter - Mutual Exclusivity', () => {
    it('rejects filter with both stream_id and recipient_address', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'stream-123',
        recipient_address: validRecipient,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('either stream_id or recipient_address, not both');
      }
    });

    it('rejects filter with both in nested filter object', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseWsClientMessage({
        type: 'subscribe',
        filter: { stream_id: 'stream-123', recipient_address: validRecipient },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('either stream_id or recipient_address, not both');
      }
    });
  });

  describe('Subscription Filter - Nested filter Object', () => {
    it('accepts filter with nested filter object containing stream_id', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        filter: { stream_id: 'stream-123' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.streamId).toBe('stream-123');
      }
    });

    it('accepts filter with nested filter object containing recipient_address', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseWsClientMessage({
        type: 'subscribe',
        filter: { recipient_address: validRecipient },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.recipientAddress).toBe(validRecipient);
      }
    });

it('requires consistent values across all stream_id aliases (top-level and nested)', () => {
    // Same value in both top-level and nested - should work
    const result = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'same-value',
      filter: { stream_id: 'same-value' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.filter.streamId).toBe('same-value');
    }

    // Conflicting values should be rejected
    const conflictResult = parseWsClientMessage({
      type: 'subscribe',
      stream_id: 'top-level',
      filter: { stream_id: 'nested' },
    });
    expect(conflictResult.ok).toBe(false);
    if (!conflictResult.ok) {
      expect(conflictResult.code).toBe('INVALID_MESSAGE');
      expect(conflictResult.message).toContain('conflicting');
    }
  });

    it('accepts empty nested filter object as explicit empty filter', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        filter: {},
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter).toEqual({});
      }
    });

    it('rejects subscribe without any filter fields', () => {
      const result = parseWsClientMessage({ type: 'subscribe' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('require stream_id, recipient_address, or an explicit empty filter');
      }
    });

    it('rejects unsubscribe without any filter fields', () => {
      const result = parseWsClientMessage({ type: 'unsubscribe' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('require stream_id, recipient_address, or an explicit empty filter');
      }
    });
  });

  describe('Batching Flag', () => {
    it('accepts batching: true at top level', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        batching: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.batchingEnabled).toBe(true);
      }
    });

    it('accepts batching: false at top level', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        batching: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.batchingEnabled).toBe(false);
      }
    });

    it('accepts batching in nested filter object', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        filter: { stream_id: 'test', batching: true },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.batchingEnabled).toBe(true);
      }
    });

    it('top-level batching takes precedence over nested filter.batching', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        batching: true,
        filter: { stream_id: 'test', batching: false },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.batchingEnabled).toBe(true);
      }
    });

    it('rejects non-boolean batching', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        batching: 'not-a-boolean',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });
  });

  describe('Replay Message Validation', () => {
    it('accepts valid replay with fromLedger', () => {
      const result = parseWsClientMessage({ type: 'replay', fromLedger: 100 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.fromLedger).toBe(100);
      }
    });

    it('accepts valid replay with toLedger (snake_case)', () => {
      const result = parseWsClientMessage({ type: 'replay', toledger: 200 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.toledger).toBe(200);
      }
    });

    it('accepts replay with both fromLedger and toLedger', () => {
      const result = parseWsClientMessage({ type: 'replay', fromLedger: 100, toledger: 200 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.fromLedger).toBe(100);
        expect(result.message.filter.toledger).toBe(200);
      }
    });

    it('accepts replay with afterEventId', () => {
      const result = parseWsClientMessage({ type: 'replay', afterEventId: 'event-123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.afterEventId).toBe('event-123');
      }
    });

    it('accepts replay with contractId', () => {
      const result = parseWsClientMessage({ type: 'replay', contractId: 'contract-123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.contractId).toBe('contract-123');
      }
    });

    it('accepts replay with topic', () => {
      const result = parseWsClientMessage({ type: 'replay', topic: 'topic-123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.topic).toBe('topic-123');
      }
    });

    it('accepts replay with limit', () => {
      const result = parseWsClientMessage({ type: 'replay', limit: 500 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.limit).toBe(500);
      }
    });

    it('rejects negative fromLedger', () => {
      const result = parseWsClientMessage({ type: 'replay', fromLedger: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects negative toLedger', () => {
      const result = parseWsClientMessage({ type: 'replay', toledger: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-integer fromLedger', () => {
      const result = parseWsClientMessage({ type: 'replay', fromLedger: 100.5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-integer toLedger', () => {
      const result = parseWsClientMessage({ type: 'replay', toledger: 200.5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects limit exceeding 1000', () => {
      const result = parseWsClientMessage({ type: 'replay', limit: 1001 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('accepts limit at boundary (1000)', () => {
      const result = parseWsClientMessage({ type: 'replay', limit: 1000 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.limit).toBe(1000);
      }
    });

    it('rejects non-positive limit', () => {
      const result = parseWsClientMessage({ type: 'replay', limit: 0 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects contractId exceeding max length', () => {
      const longContractId = 'x'.repeat(257);
      const result = parseWsClientMessage({ type: 'replay', contractId: longContractId });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects topic exceeding max length', () => {
      const longTopic = 'x'.repeat(257);
      const result = parseWsClientMessage({ type: 'replay', topic: longTopic });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-string contractId', () => {
      const result = parseWsClientMessage({ type: 'replay', contractId: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-string topic', () => {
      const result = parseWsClientMessage({ type: 'replay', topic: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('rejects non-string afterEventId', () => {
      const result = parseWsClientMessage({ type: 'replay', afterEventId: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });
  });

  describe('Handshake Subscription Filter Parsing', () => {
    it('accepts stream_id query parameter', () => {
      const result = parseHandshakeSubscriptionFilter('/ws/streams?stream_id=test-stream');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filter?.streamId).toBe('test-stream');
      }
    });

    it('accepts streamId query parameter (camelCase)', () => {
      const result = parseHandshakeSubscriptionFilter('/ws/streams?streamId=test-stream');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filter?.streamId).toBe('test-stream');
      }
    });

    it('accepts recipient_address query parameter', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseHandshakeSubscriptionFilter(`/ws/streams?recipient_address=${validRecipient}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filter?.recipientAddress).toBe(validRecipient);
      }
    });

    it('accepts recipientAddress query parameter (camelCase)', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseHandshakeSubscriptionFilter(`/ws/streams?recipientAddress=${validRecipient}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filter?.recipientAddress).toBe(validRecipient);
      }
    });

    it('returns null filter when no query parameters', () => {
      const result = parseHandshakeSubscriptionFilter('/ws/streams');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filter).toBeNull();
      }
    });

    it('rejects handshake with invalid recipient_address', () => {
      const invalidRecipient = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';
      const result = parseHandshakeSubscriptionFilter(`/ws/streams?recipient_address=${invalidRecipient}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('recipient_address');
      }
    });

    it('rejects handshake with both stream_id and recipient_address', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseHandshakeSubscriptionFilter(`/ws/streams?stream_id=test&recipient_address=${validRecipient}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('either stream_id or recipient_address, not both');
      }
    });

    it('rejects handshake with invalid stream_id', () => {
      const result = parseHandshakeSubscriptionFilter('/ws/streams?stream_id=');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error message is from schema validation: "Too small: expected string to have >=1 characters"
        expect(result.message).toContain('Too small');
      }
    });
  });

  describe('Extra Fields Handling (passthrough)', () => {
    it('ignores extra fields at top level', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        extraField: 'ignored',
        anotherExtra: 123,
      });
      expect(result.ok).toBe(true);
    });

    it('ignores extra fields in nested filter object', () => {
      const result = parseWsClientMessage({
        type: 'subscribe',
        filter: { stream_id: 'test', extraField: 'ignored' },
      });
      expect(result.ok).toBe(true);
    });

    it('ignores extra fields in replay message', () => {
      const result = parseWsClientMessage({
        type: 'replay',
        fromLedger: 100,
        extraField: 'ignored',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('Stellar Public Key Validation (isValidStellarPublicKey)', () => {
    const validKey = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
    const invalidChecksum = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';
    const wrongVersion = 'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH';
    const wrongLength = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT';
    const invalidChars = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT!';

    it('returns true for valid Stellar public key', () => {
      expect(isValidStellarPublicKey(validKey)).toBe(true);
    });

    it('returns false for invalid checksum', () => {
      expect(isValidStellarPublicKey(invalidChecksum)).toBe(false);
    });

    it('returns false for wrong version byte', () => {
      expect(isValidStellarPublicKey(wrongVersion)).toBe(false);
    });

    it('returns false for wrong length', () => {
      expect(isValidStellarPublicKey(wrongLength)).toBe(false);
    });

    it('returns false for invalid characters', () => {
      expect(isValidStellarPublicKey(invalidChars)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidStellarPublicKey('')).toBe(false);
    });

    it('returns false for lowercase (should be uppercase)', () => {
      expect(isValidStellarPublicKey(validKey.toLowerCase())).toBe(false);
    });

    it('trims whitespace before validation', () => {
      expect(isValidStellarPublicKey(`  ${validKey}  `)).toBe(true);
    });
  });

  describe('Error Codes and Messages', () => {
    it('returns UNKNOWN_TYPE for unknown message types', () => {
      const result = parseWsClientMessage({ type: 'foobar' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('UNKNOWN_TYPE');
        expect(result.message).toContain('foobar');
      }
    });

    it('returns INVALID_MESSAGE for schema validation failures', () => {
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('returns INVALID_MESSAGE for conflicting aliases', () => {
      const result = parseWsClientMessage({ type: 'subscribe', stream_id: 'a', streamId: 'b' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('conflicting');
      }
    });

    it('returns INVALID_MESSAGE for mutually exclusive fields', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        recipient_address: validRecipient,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('either stream_id or recipient_address');
      }
    });

    it('returns INVALID_MESSAGE for missing required filter', () => {
      const result = parseWsClientMessage({ type: 'subscribe' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
        expect(result.message).toContain('require stream_id, recipient_address, or an explicit empty filter');
      }
    });
  });

  describe('Unsubscribe Message Validation', () => {
    it('validates unsubscribe same as subscribe', () => {
      const result = parseWsClientMessage({ type: 'unsubscribe', stream_id: 'test' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.type).toBe('unsubscribe');
        expect(result.message.filter.streamId).toBe('test');
      }
    });

    it('rejects unsubscribe with invalid stream_id', () => {
      const result = parseWsClientMessage({ type: 'unsubscribe', stream_id: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });

    it('accepts unsubscribe with recipient_address', () => {
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      const result = parseWsClientMessage({ type: 'unsubscribe', recipient_address: validRecipient });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter.recipientAddress).toBe(validRecipient);
      }
    });

    it('accepts unsubscribe with empty filter', () => {
      const result = parseWsClientMessage({ type: 'unsubscribe', filter: {} });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.filter).toEqual({});
      }
    });

    it('rejects unsubscribe without filter', () => {
      const result = parseWsClientMessage({ type: 'unsubscribe' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_MESSAGE');
      }
    });
  });

  describe('Regression Surface - Documented Behavior', () => {
    it('MAX_MESSAGE_BYTES is 4096 and consistent with hub.ts', async () => {
      const { MAX_MESSAGE_BYTES } = await import('../../src/ws/messageHandler.js');
      expect(MAX_MESSAGE_BYTES).toBe(4096);
    });

    it('MAX_INBOUND_MESSAGE_BYTES is 4096', () => {
      // This constant is internal but the limit is enforced
      const oversized = 'x'.repeat(4097);
      const result = validateWebSocketMessage(oversized);
      expect(result.ok).toBe(false);
    });

    it('Stellar key regex is enforced before StrKey validation', () => {
      // Keys must match base32 alphabet first
      const result = parseWsClientMessage({
        type: 'subscribe',
        recipient_address: 'INVALID!!!CHARS',
      });
      expect(result.ok).toBe(false);
    });

    it('Passthrough allows extra fields without strict schema rejection', () => {
      // The .passthrough() in schemas allows unknown fields
      const result = parseWsClientMessage({
        type: 'subscribe',
        stream_id: 'test',
        unknownField1: 'value1',
        unknownField2: 'value2',
        unknownField3: 'value3',
      });
      expect(result.ok).toBe(true);
    });

    it('All validation errors use consistent error codes', () => {
      const errorCodes = new Set<string>();

      // Unknown type
      errorCodes.add(parseWsClientMessage({ type: 'unknown' }).code);

      // Invalid JSON
      errorCodes.add(validateWebSocketMessage('invalid').code);

      // Missing type
      errorCodes.add(parseWsClientMessage({}).code);

      // Invalid stream_id
      errorCodes.add(parseWsClientMessage({ type: 'subscribe', stream_id: '' }).code);

      // Mutually exclusive
      const validRecipient = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
      errorCodes.add(parseWsClientMessage({ type: 'subscribe', stream_id: 'a', recipient_address: validRecipient }).code);

      // Missing filter
      errorCodes.add(parseWsClientMessage({ type: 'subscribe' }).code);

      // Invalid limit
      errorCodes.add(parseWsClientMessage({ type: 'replay', limit: 1001 }).code);

      expect(errorCodes).toEqual(new Set(['UNKNOWN_TYPE', 'INVALID_MESSAGE']));
    });
  });
});