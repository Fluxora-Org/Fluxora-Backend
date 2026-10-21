import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import {
  SubscriptionRouter,
  validateSubscriptionFilter,
  extractRecipientAddress,
  MAX_HANDSHAKE_QUERY_LENGTH,
  MAX_FILTER_FIELD_LENGTH,
  type SendErrorFn,
} from './subscriptionRouter.js';
import { ConnectionRegistry, createClientState } from './connectionRegistry.js';
import type { ClientState, StreamUpdateEvent } from './hubTypes.js';
import type { SubscriptionFilter } from './messageHandler.js';

// Mock dependencies before imports are used
vi.mock('../db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn(),
  },
}));

vi.mock('./messageHandler.js', () => ({
  isValidStellarPublicKey: vi.fn((key: string) => {
    if (typeof key !== 'string') return false;
    const trimmed = key.trim();
    return trimmed.startsWith('G') && trimmed.length === 56;
  }),
  parseHandshakeSubscriptionFilter: vi.fn(),
}));

import { streamRepository } from '../db/repositories/streamRepository.js';
import {
  isValidStellarPublicKey,
  parseHandshakeSubscriptionFilter,
} from './messageHandler.js';

const VALID_STELLAR_KEY_1 = 'G' + 'A'.repeat(55);
const VALID_STELLAR_KEY_2 = 'G' + 'B'.repeat(55);
const VALID_STELLAR_KEY_3 = 'G' + 'C'.repeat(55);

function createMockSocket(id: string = 'ws-test'): WebSocket {
  return { id, readyState: WebSocket.OPEN } as unknown as WebSocket;
}

function createTestClientState(ws: WebSocket, subject?: string): ClientState {
  return createClientState({
    id: (ws as unknown as { id: string }).id ?? 'client-1',
    connectedAt: Date.now(),
    ip: '127.0.0.1',
    authenticatedSubject: subject,
  });
}

describe('subscriptionRouter', () => {
  let registry: ConnectionRegistry;
  let sendError: SendErrorFn;
  let onSubscriptionLimitExceeded: () => void;
  let router: SubscriptionRouter;
  const MAX_SUBS = 3;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ConnectionRegistry();
    sendError = vi.fn();
    onSubscriptionLimitExceeded = vi.fn();
    router = new SubscriptionRouter(
      registry,
      MAX_SUBS,
      sendError,
      onSubscriptionLimitExceeded
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Exported Constants
  // ───────────────────────────────────────────────────────────────────────────
  describe('Constants', () => {
    it('defines expected limit constants', () => {
      expect(MAX_HANDSHAKE_QUERY_LENGTH).toBe(2048);
      expect(MAX_FILTER_FIELD_LENGTH).toBe(256);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // validateSubscriptionFilter
  // ───────────────────────────────────────────────────────────────────────────
  describe('validateSubscriptionFilter', () => {
    describe('Normal paths', () => {
      it('accepts a valid streamId filter', () => {
        const filter: SubscriptionFilter = { streamId: 'stream-123' };
        expect(validateSubscriptionFilter(filter)).toEqual({ ok: true, filter });
      });

      it('accepts a valid recipientAddress filter', () => {
        const filter: SubscriptionFilter = { recipientAddress: VALID_STELLAR_KEY_1 };
        expect(validateSubscriptionFilter(filter)).toEqual({ ok: true, filter });
      });

      it('accepts a filter with both streamId and recipientAddress', () => {
        const filter: SubscriptionFilter = {
          streamId: 'stream-123',
          recipientAddress: VALID_STELLAR_KEY_1,
        };
        expect(validateSubscriptionFilter(filter)).toEqual({ ok: true, filter });
      });

      it('accepts a filter with batchingEnabled flag', () => {
        const filter: SubscriptionFilter = {
          streamId: 'stream-123',
          batchingEnabled: true,
        };
        expect(validateSubscriptionFilter(filter)).toEqual({ ok: true, filter });
      });
    });

    describe('Failure modes and boundary conditions', () => {
      it('rejects non-object inputs with INVALID_FILTER', () => {
        const invalidInputs = [
          null,
          undefined,
          'string',
          123,
          true,
          [],
          () => {},
        ];

        for (const input of invalidInputs) {
          const res = validateSubscriptionFilter(input as unknown as SubscriptionFilter);
          expect(res).toEqual({
            ok: false,
            code: 'INVALID_FILTER',
            message: 'Subscription filter must be an object',
          });
        }
      });

      it('rejects an empty filter with EMPTY_INPUT', () => {
        const res = validateSubscriptionFilter({} as SubscriptionFilter);
        expect(res).toEqual({
          ok: false,
          code: 'EMPTY_INPUT',
          message: 'Subscription filter must not be empty',
        });
      });

      it('rejects filter with undefined fields with EMPTY_INPUT', () => {
        const res = validateSubscriptionFilter({
          streamId: undefined,
          recipientAddress: undefined,
        });
        expect(res).toEqual({
          ok: false,
          code: 'EMPTY_INPUT',
          message: 'Subscription filter must not be empty',
        });
      });

      it('rejects empty or whitespace streamId with INVALID_FILTER', () => {
        expect(validateSubscriptionFilter({ streamId: '' })).toEqual({
          ok: false,
          code: 'INVALID_FILTER',
          message: 'streamId must be a non-empty string',
        });
        expect(validateSubscriptionFilter({ streamId: '   ' })).toEqual({
          ok: false,
          code: 'INVALID_FILTER',
          message: 'streamId must be a non-empty string',
        });
      });

      it('rejects non-string streamId with INVALID_FILTER', () => {
        expect(
          validateSubscriptionFilter({ streamId: 123 as unknown as string })
        ).toEqual({
          ok: false,
          code: 'INVALID_FILTER',
          message: 'streamId must be a non-empty string',
        });
      });

      it('accepts streamId of maximum allowed length (256 chars)', () => {
        const maxStreamId = 's'.repeat(MAX_FILTER_FIELD_LENGTH);
        const filter: SubscriptionFilter = { streamId: maxStreamId };
        expect(validateSubscriptionFilter(filter)).toEqual({ ok: true, filter });
      });

      it('rejects streamId exceeding maximum length (257 chars) with OVERSIZED_INPUT', () => {
        const oversizedStreamId = 's'.repeat(MAX_FILTER_FIELD_LENGTH + 1);
        expect(validateSubscriptionFilter({ streamId: oversizedStreamId })).toEqual({
          ok: false,
          code: 'OVERSIZED_INPUT',
          message: 'streamId is too long',
        });
      });

      it('rejects empty or whitespace recipientAddress with INVALID_FILTER', () => {
        expect(validateSubscriptionFilter({ recipientAddress: '' })).toEqual({
          ok: false,
          code: 'INVALID_FILTER',
          message: 'recipientAddress must be a non-empty string',
        });
        expect(validateSubscriptionFilter({ recipientAddress: '   ' })).toEqual({
          ok: false,
          code: 'INVALID_FILTER',
          message: 'recipientAddress must be a non-empty string',
        });
      });

      it('rejects non-string recipientAddress with INVALID_FILTER', () => {
        expect(
          validateSubscriptionFilter({ recipientAddress: {} as unknown as string })
        ).toEqual({
          ok: false,
          code: 'INVALID_FILTER',
          message: 'recipientAddress must be a non-empty string',
        });
      });

      it('accepts recipientAddress of maximum allowed length (256 chars)', () => {
        const maxRecipient = 'r'.repeat(MAX_FILTER_FIELD_LENGTH);
        const filter: SubscriptionFilter = { recipientAddress: maxRecipient };
        expect(validateSubscriptionFilter(filter)).toEqual({ ok: true, filter });
      });

      it('rejects recipientAddress exceeding maximum length (257 chars) with OVERSIZED_INPUT', () => {
        const oversizedRecipient = 'r'.repeat(MAX_FILTER_FIELD_LENGTH + 1);
        expect(
          validateSubscriptionFilter({ recipientAddress: oversizedRecipient })
        ).toEqual({
          ok: false,
          code: 'OVERSIZED_INPUT',
          message: 'recipientAddress is too long',
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // extractRecipientAddress
  // ───────────────────────────────────────────────────────────────────────────
  describe('extractRecipientAddress', () => {
    describe('Normal paths and precedence', () => {
      it('extracts explicit recipientAddress from event', () => {
        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-1',
          recipientAddress: VALID_STELLAR_KEY_1,
          payload: null,
        };
        expect(extractRecipientAddress(event)).toBe(VALID_STELLAR_KEY_1);
      });

      it('trims explicit recipientAddress', () => {
        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-1',
          recipientAddress: `  ${VALID_STELLAR_KEY_1}  `,
          payload: null,
        };
        expect(extractRecipientAddress(event)).toBe(VALID_STELLAR_KEY_1);
      });

      it('extracts recipient_address from payload when explicit field is missing', () => {
        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-1',
          payload: { recipient_address: VALID_STELLAR_KEY_1 },
        };
        expect(extractRecipientAddress(event)).toBe(VALID_STELLAR_KEY_1);
      });

      it('extracts recipientAddress from payload when recipient_address is missing', () => {
        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-1',
          payload: { recipientAddress: VALID_STELLAR_KEY_2 },
        };
        expect(extractRecipientAddress(event)).toBe(VALID_STELLAR_KEY_2);
      });

      it('extracts recipient from payload when other candidates are missing', () => {
        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-1',
          payload: { recipient: VALID_STELLAR_KEY_3 },
        };
        expect(extractRecipientAddress(event)).toBe(VALID_STELLAR_KEY_3);
      });

      it('honors field precedence: explicit > recipient_address > recipientAddress > recipient', () => {
        const event1: StreamUpdateEvent = {
          streamId: 's1',
          eventId: 'e1',
          recipientAddress: 'EXPLICIT',
          payload: {
            recipient_address: 'PAYLOAD_SNAKE',
            recipientAddress: 'PAYLOAD_CAMEL',
            recipient: 'PAYLOAD_SHORT',
          },
        };
        expect(extractRecipientAddress(event1)).toBe('EXPLICIT');

        const event2: StreamUpdateEvent = {
          streamId: 's1',
          eventId: 'e1',
          payload: {
            recipient_address: 'PAYLOAD_SNAKE',
            recipientAddress: 'PAYLOAD_CAMEL',
            recipient: 'PAYLOAD_SHORT',
          },
        };
        expect(extractRecipientAddress(event2)).toBe('PAYLOAD_SNAKE');

        const event3: StreamUpdateEvent = {
          streamId: 's1',
          eventId: 'e1',
          payload: {
            recipientAddress: 'PAYLOAD_CAMEL',
            recipient: 'PAYLOAD_SHORT',
          },
        };
        expect(extractRecipientAddress(event3)).toBe('PAYLOAD_CAMEL');
      });
    });

    describe('Failure modes and boundary conditions', () => {
      it('falls back to payload when explicit recipientAddress is empty or whitespace', () => {
        const event: StreamUpdateEvent = {
          streamId: 's1',
          eventId: 'e1',
          recipientAddress: '   ',
          payload: { recipient: VALID_STELLAR_KEY_1 },
        };
        expect(extractRecipientAddress(event)).toBe(VALID_STELLAR_KEY_1);
      });

      it('returns undefined when payload is not an object (null, number, array, undefined)', () => {
        expect(
          extractRecipientAddress({ streamId: 's1', eventId: 'e1', payload: null })
        ).toBeUndefined();
        expect(
          extractRecipientAddress({ streamId: 's1', eventId: 'e1', payload: undefined })
        ).toBeUndefined();
        expect(
          extractRecipientAddress({ streamId: 's1', eventId: 'e1', payload: 'string' })
        ).toBeUndefined();
        expect(
          extractRecipientAddress({ streamId: 's1', eventId: 'e1', payload: 12345 })
        ).toBeUndefined();
        expect(
          extractRecipientAddress({ streamId: 's1', eventId: 'e1', payload: [VALID_STELLAR_KEY_1] })
        ).toBeUndefined();
      });

      it('returns undefined when payload fields are non-string or whitespace', () => {
        expect(
          extractRecipientAddress({
            streamId: 's1',
            eventId: 'e1',
            payload: { recipient_address: 12345 },
          })
        ).toBeUndefined();
        expect(
          extractRecipientAddress({
            streamId: 's1',
            eventId: 'e1',
            payload: { recipient_address: '   ' },
          })
        ).toBeUndefined();
        expect(
          extractRecipientAddress({
            streamId: 's1',
            eventId: 'e1',
            payload: {},
          })
        ).toBeUndefined();
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SubscriptionRouter.authorize
  // ───────────────────────────────────────────────────────────────────────────
  describe('SubscriptionRouter.authorize', () => {
    let ws: WebSocket;
    let state: ClientState;

    beforeEach(() => {
      ws = createMockSocket('client-ws');
      state = createTestClientState(ws, VALID_STELLAR_KEY_1);
      registry.register(ws, state);
    });

    describe('Normal paths', () => {
      it('authorizes stream filter when subject is the stream sender', async () => {
        vi.mocked(streamRepository.getById).mockResolvedValueOnce({
          id: 'stream-1',
          sender_address: VALID_STELLAR_KEY_1,
          recipient_address: VALID_STELLAR_KEY_2,
        } as unknown as Awaited<ReturnType<typeof streamRepository.getById>>);

        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({ ok: true, filter });
      });

      it('authorizes stream filter when subject is the stream recipient', async () => {
        vi.mocked(streamRepository.getById).mockResolvedValueOnce({
          id: 'stream-1',
          sender_address: VALID_STELLAR_KEY_2,
          recipient_address: VALID_STELLAR_KEY_1,
        } as unknown as Awaited<ReturnType<typeof streamRepository.getById>>);

        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({ ok: true, filter });
      });

      it('authorizes recipientAddress filter when subject matches exactly', async () => {
        const filter: SubscriptionFilter = { recipientAddress: VALID_STELLAR_KEY_1 };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({ ok: true, filter });
      });
    });

    describe('Failure modes', () => {
      it('returns validation error immediately if filter is invalid', async () => {
        const result = await router.authorize(ws, {} as SubscriptionFilter);
        expect(result).toEqual({
          ok: false,
          code: 'EMPTY_INPUT',
          message: 'Subscription filter must not be empty',
        });
      });

      it('returns UNAUTHORIZED if WebSocket socket is not registered in registry', async () => {
        const unregisteredWs = createMockSocket('unregistered');
        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        const result = await router.authorize(unregisteredWs, filter);

        expect(result).toEqual({
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'WebSocket client is not registered',
        });
      });

      it('returns NOT_FOUND if stream does not exist in repository', async () => {
        vi.mocked(streamRepository.getById).mockResolvedValueOnce(null);

        const filter: SubscriptionFilter = { streamId: 'non-existent' };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Stream not found',
        });
      });

      it('returns FORBIDDEN for stream filter if client has no authenticated subject', async () => {
        state.authenticatedSubject = undefined;
        vi.mocked(streamRepository.getById).mockResolvedValueOnce({
          id: 'stream-1',
          sender_address: VALID_STELLAR_KEY_1,
          recipient_address: VALID_STELLAR_KEY_2,
        } as unknown as Awaited<ReturnType<typeof streamRepository.getById>>);

        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({
          ok: false,
          code: 'FORBIDDEN',
          message: 'Not authorized for this stream',
        });
      });

      it('returns FORBIDDEN for stream filter if client is neither sender nor recipient', async () => {
        state.authenticatedSubject = VALID_STELLAR_KEY_3;
        vi.mocked(streamRepository.getById).mockResolvedValueOnce({
          id: 'stream-1',
          sender_address: VALID_STELLAR_KEY_1,
          recipient_address: VALID_STELLAR_KEY_2,
        } as unknown as Awaited<ReturnType<typeof streamRepository.getById>>);

        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({
          ok: false,
          code: 'FORBIDDEN',
          message: 'Not authorized for this stream',
        });
      });

      it('returns UNAUTHORIZED for recipientAddress filter if client has no authenticated subject', async () => {
        state.authenticatedSubject = undefined;

        const filter: SubscriptionFilter = { recipientAddress: VALID_STELLAR_KEY_1 };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({
          ok: false,
          code: 'UNAUTHORIZED',
          message:
            'recipient_address subscriptions require an authenticated Stellar public key subject',
        });
      });

      it('returns UNAUTHORIZED for recipientAddress filter if client subject is not a valid Stellar key', async () => {
        state.authenticatedSubject = 'invalid-non-stellar-subject';

        const filter: SubscriptionFilter = { recipientAddress: VALID_STELLAR_KEY_1 };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({
          ok: false,
          code: 'UNAUTHORIZED',
          message:
            'recipient_address subscriptions require an authenticated Stellar public key subject',
        });
      });

      it('returns FORBIDDEN for recipientAddress filter if subject does not match requested recipient', async () => {
        state.authenticatedSubject = VALID_STELLAR_KEY_2;

        const filter: SubscriptionFilter = { recipientAddress: VALID_STELLAR_KEY_1 };
        const result = await router.authorize(ws, filter);

        expect(result).toEqual({
          ok: false,
          code: 'FORBIDDEN',
          message: 'recipient_address subscriptions must match the authenticated subject',
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SubscriptionRouter.subscribe
  // ───────────────────────────────────────────────────────────────────────────
  describe('SubscriptionRouter.subscribe', () => {
    let ws: WebSocket;
    let state: ClientState;

    beforeEach(() => {
      ws = createMockSocket('client-ws');
      state = createTestClientState(ws, VALID_STELLAR_KEY_1);
      registry.register(ws, state);
    });

    describe('Normal path', () => {
      it('registers a subscription filter on the client and indexes it in the registry', () => {
        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        router.subscribe(ws, filter);

        expect(state.subscriptionFilters.has('stream:stream-1')).toBe(true);
        expect(registry.streamSubscribers('stream-1').has(ws)).toBe(true);
        expect(sendError).not.toHaveBeenCalled();
      });
    });

    describe('Failure modes and boundary conditions', () => {
      it('silently ignores unregistered sockets', () => {
        const unregisteredWs = createMockSocket('unregistered');
        router.subscribe(unregisteredWs, { streamId: 'stream-1' });

        expect(sendError).not.toHaveBeenCalled();
        expect(registry.streamSubscribers('stream-1').has(unregisteredWs)).toBe(false);
      });

      it('sends protocol error when filter validation fails', () => {
        router.subscribe(ws, {} as SubscriptionFilter);

        expect(sendError).toHaveBeenCalledWith(
          ws,
          'EMPTY_INPUT',
          'Subscription filter must not be empty'
        );
        expect(state.subscriptionFilters.size).toBe(0);
      });

      it('is a no-op when subscribing to an already active filter', () => {
        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        router.subscribe(ws, filter);
        expect(state.subscriptionFilters.size).toBe(1);

        // Second subscription for the exact same key
        router.subscribe(ws, filter);
        expect(state.subscriptionFilters.size).toBe(1);
        expect(sendError).not.toHaveBeenCalled();
      });

      it('enforces maximum subscriptions cap and notifies callback', () => {
        // Router was initialized with MAX_SUBS = 3
        router.subscribe(ws, { streamId: 'stream-1' });
        router.subscribe(ws, { streamId: 'stream-2' });
        router.subscribe(ws, { streamId: 'stream-3' });
        expect(state.subscriptionFilters.size).toBe(3);

        // Fourth subscription exceeds cap
        router.subscribe(ws, { streamId: 'stream-4' });

        expect(onSubscriptionLimitExceeded).toHaveBeenCalledTimes(1);
        expect(sendError).toHaveBeenCalledWith(
          ws,
          'SUBSCRIPTION_LIMIT_EXCEEDED',
          'Connection is limited to 3 subscriptions'
        );
        // Ensure state was not mutated
        expect(state.subscriptionFilters.size).toBe(3);
        expect(state.subscriptionFilters.has('stream:stream-4')).toBe(false);
      });

      it('boundary: cap of 0 rejects first subscription immediately', () => {
        const zeroCapRouter = new SubscriptionRouter(
          registry,
          0,
          sendError,
          onSubscriptionLimitExceeded
        );

        zeroCapRouter.subscribe(ws, { streamId: 'stream-1' });

        expect(onSubscriptionLimitExceeded).toHaveBeenCalledTimes(1);
        expect(sendError).toHaveBeenCalledWith(
          ws,
          'SUBSCRIPTION_LIMIT_EXCEEDED',
          'Connection is limited to 0 subscriptions'
        );
        expect(state.subscriptionFilters.size).toBe(0);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SubscriptionRouter.unsubscribe
  // ───────────────────────────────────────────────────────────────────────────
  describe('SubscriptionRouter.unsubscribe', () => {
    let ws: WebSocket;
    let state: ClientState;

    beforeEach(() => {
      ws = createMockSocket('client-ws');
      state = createTestClientState(ws, VALID_STELLAR_KEY_1);
      registry.register(ws, state);
    });

    describe('Normal path', () => {
      it('removes an existing subscription from client state and registry indexes', () => {
        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        router.subscribe(ws, filter);
        expect(state.subscriptionFilters.has('stream:stream-1')).toBe(true);
        expect(registry.streamSubscribers('stream-1').has(ws)).toBe(true);

        router.unsubscribe(ws, filter);
        expect(state.subscriptionFilters.has('stream:stream-1')).toBe(false);
        expect(registry.streamSubscribers('stream-1').has(ws)).toBe(false);
      });
    });

    describe('Failure modes and edge cases', () => {
      it('silently ignores unregistered sockets', () => {
        const unregisteredWs = createMockSocket('unregistered');
        expect(() => {
          router.unsubscribe(unregisteredWs, { streamId: 'stream-1' });
        }).not.toThrow();
      });

      it('is a no-op when filter is not active for the connection', () => {
        router.subscribe(ws, { streamId: 'stream-1' });

        router.unsubscribe(ws, { streamId: 'stream-2' });

        expect(state.subscriptionFilters.size).toBe(1);
        expect(state.subscriptionFilters.has('stream:stream-1')).toBe(true);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SubscriptionRouter.applyHandshakeSubscription
  // ───────────────────────────────────────────────────────────────────────────
  describe('SubscriptionRouter.applyHandshakeSubscription', () => {
    let ws: WebSocket;
    let state: ClientState;

    beforeEach(() => {
      ws = createMockSocket('client-ws');
      state = createTestClientState(ws, VALID_STELLAR_KEY_1);
      registry.register(ws, state);
    });

    describe('Normal path', () => {
      it('applies handshake subscription when query is valid and authorized', async () => {
        const filter: SubscriptionFilter = { streamId: 'stream-1' };
        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: true,
          filter,
        });
        vi.mocked(streamRepository.getById).mockResolvedValueOnce({
          id: 'stream-1',
          sender_address: VALID_STELLAR_KEY_1,
          recipient_address: VALID_STELLAR_KEY_2,
        } as unknown as Awaited<ReturnType<typeof streamRepository.getById>>);

        const req = { url: '/ws?stream_id=stream-1' } as IncomingMessage;
        router.applyHandshakeSubscription(ws, req);

        await vi.waitFor(() => {
          expect(state.subscriptionFilters.has('stream:stream-1')).toBe(true);
        });
        expect(sendError).not.toHaveBeenCalled();
      });
    });

    describe('Failure modes and boundary conditions', () => {
      it('rejects oversized handshake query exceeding 2048 bytes with OVERSIZED_INPUT', () => {
        const oversizedUrl = `/?${'x'.repeat(MAX_HANDSHAKE_QUERY_LENGTH + 1)}`;
        const req = { url: oversizedUrl } as IncomingMessage;

        router.applyHandshakeSubscription(ws, req);

        expect(sendError).toHaveBeenCalledWith(
          ws,
          'OVERSIZED_INPUT',
          'Handshake subscription query string is too large'
        );
        expect(parseHandshakeSubscriptionFilter).not.toHaveBeenCalled();
      });

      it('accepts handshake query string of exactly 2048 bytes', () => {
        const exactUrl = `/?${'x'.repeat(MAX_HANDSHAKE_QUERY_LENGTH - 2)}`;
        expect(Buffer.byteLength(exactUrl, 'utf8')).toBe(MAX_HANDSHAKE_QUERY_LENGTH);
        const req = { url: exactUrl } as IncomingMessage;

        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: true,
          filter: null,
        });

        router.applyHandshakeSubscription(ws, req);

        expect(sendError).not.toHaveBeenCalled();
        expect(parseHandshakeSubscriptionFilter).toHaveBeenCalledWith(exactUrl);
      });

      it('handles undefined req.url by defaulting to "/"', () => {
        const req = {} as IncomingMessage;
        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: true,
          filter: null,
        });

        router.applyHandshakeSubscription(ws, req);

        expect(parseHandshakeSubscriptionFilter).toHaveBeenCalledWith('/');
        expect(sendError).not.toHaveBeenCalled();
      });

      it('sends INVALID_MESSAGE when handshake query parser reports error', () => {
        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: false,
          message: 'Malformed query parameters',
        });

        const req = { url: '/ws?bad=param' } as IncomingMessage;
        router.applyHandshakeSubscription(ws, req);

        expect(sendError).toHaveBeenCalledWith(
          ws,
          'INVALID_MESSAGE',
          'Malformed query parameters'
        );
      });

      it('does nothing when handshake query contains no subscription filter (null)', () => {
        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: true,
          filter: null,
        });

        const req = { url: '/ws' } as IncomingMessage;
        router.applyHandshakeSubscription(ws, req);

        expect(sendError).not.toHaveBeenCalled();
        expect(state.subscriptionFilters.size).toBe(0);
      });

      it('sends authorization error when filter authorization fails', async () => {
        const filter: SubscriptionFilter = { streamId: 'unauthorized-stream' };
        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: true,
          filter,
        });
        vi.mocked(streamRepository.getById).mockResolvedValueOnce(null); // NOT_FOUND

        const req = { url: '/ws?stream_id=unauthorized-stream' } as IncomingMessage;
        router.applyHandshakeSubscription(ws, req);

        await vi.waitFor(() => {
          expect(sendError).toHaveBeenCalledWith(ws, 'NOT_FOUND', 'Stream not found');
        });
        expect(state.subscriptionFilters.size).toBe(0);
      });

      it('sends INTERNAL_ERROR when authorization promise rejects', async () => {
        const filter: SubscriptionFilter = { streamId: 'crash-stream' };
        vi.mocked(parseHandshakeSubscriptionFilter).mockReturnValueOnce({
          ok: true,
          filter,
        });
        vi.mocked(streamRepository.getById).mockRejectedValueOnce(
          new Error('Database connectivity lost')
        );

        const req = { url: '/ws?stream_id=crash-stream' } as IncomingMessage;
        router.applyHandshakeSubscription(ws, req);

        await vi.waitFor(() => {
          expect(sendError).toHaveBeenCalledWith(
            ws,
            'INTERNAL_ERROR',
            'Failed to authorize subscription filter'
          );
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SubscriptionRouter.resolveTargets
  // ───────────────────────────────────────────────────────────────────────────
  describe('SubscriptionRouter.resolveTargets', () => {
    let wsImmediate: WebSocket;
    let wsBatched: WebSocket;
    let stateImmediate: ClientState;
    let stateBatched: ClientState;

    beforeEach(() => {
      wsImmediate = createMockSocket('ws-imm');
      stateImmediate = createTestClientState(wsImmediate, VALID_STELLAR_KEY_1);
      registry.register(wsImmediate, stateImmediate);

      wsBatched = createMockSocket('ws-batch');
      stateBatched = createTestClientState(wsBatched, VALID_STELLAR_KEY_2);
      registry.register(wsBatched, stateBatched);
    });

    describe('Normal routing and batching preference splitting', () => {
      it('routes subscribers to immediate vs batched based on batchingEnabled flag', () => {
        router.subscribe(wsImmediate, { streamId: 'stream-1', batchingEnabled: false });
        router.subscribe(wsBatched, { streamId: 'stream-1', batchingEnabled: true });

        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-100',
          payload: null,
        };

        const targets = router.resolveTargets(event);

        expect(targets.immediate).toEqual([wsImmediate]);
        expect(targets.batched).toEqual([{ ws: wsBatched, state: stateBatched }]);
      });

      it('routes client to batched if ANY of its subscription filters enabled batching', () => {
        // Client has one unbatched filter and one batched filter
        router.subscribe(wsImmediate, { streamId: 'stream-1', batchingEnabled: false });
        router.subscribe(wsImmediate, { streamId: 'stream-2', batchingEnabled: true });

        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-101',
          payload: null,
        };

        const targets = router.resolveTargets(event);

        expect(targets.immediate).toHaveLength(0);
        expect(targets.batched).toEqual([{ ws: wsImmediate, state: stateImmediate }]);
      });

      it('merges stream-scoped and recipient-scoped subscribers without duplication', () => {
        // wsImmediate is subscribed to BOTH stream-1 AND recipientAddress
        router.subscribe(wsImmediate, { streamId: 'stream-1' });
        router.subscribe(wsImmediate, { recipientAddress: VALID_STELLAR_KEY_1 });

        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-102',
          recipientAddress: VALID_STELLAR_KEY_1,
          payload: null,
        };

        const targets = router.resolveTargets(event);

        // Sockets must be deduplicated
        expect(targets.immediate).toHaveLength(1);
        expect(targets.immediate).toEqual([wsImmediate]);
      });

      it('resolves recipient address from event payload variants', () => {
        router.subscribe(wsImmediate, { recipientAddress: VALID_STELLAR_KEY_1 });

        const event: StreamUpdateEvent = {
          streamId: 'stream-other',
          eventId: 'evt-103',
          payload: { recipient_address: VALID_STELLAR_KEY_1 },
        };

        const targets = router.resolveTargets(event);

        expect(targets.immediate).toEqual([wsImmediate]);
      });
    });

    describe('Failure modes and boundary conditions', () => {
      it('returns empty lists when no subscribers match stream or recipient', () => {
        router.subscribe(wsImmediate, { streamId: 'stream-1' });

        const event: StreamUpdateEvent = {
          streamId: 'stream-unmatched',
          eventId: 'evt-104',
          recipientAddress: 'G_UNMATCHED',
          payload: null,
        };

        const targets = router.resolveTargets(event);

        expect(targets.immediate).toEqual([]);
        expect(targets.batched).toEqual([]);
      });

      it('safely skips subscribers whose state has been unregistered', () => {
        router.subscribe(wsImmediate, { streamId: 'stream-1' });

        // Unregister client state while subscription remains indexed
        registry.unregister(wsImmediate);

        const event: StreamUpdateEvent = {
          streamId: 'stream-1',
          eventId: 'evt-105',
          payload: null,
        };

        const targets = router.resolveTargets(event);

        expect(targets.immediate).toEqual([]);
        expect(targets.batched).toEqual([]);
      });
    });
  });
});
