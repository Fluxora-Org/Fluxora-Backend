import { z } from 'zod';
import type { StreamEventReplayFilter } from '../db/types.js';
import { STELLAR_PUBLIC_KEY_REGEX } from '../validation/schemas.js';
import { logger } from '../lib/logger.js';

const MAX_FILTER_VALUE_LENGTH = 256;
const MAX_INBOUND_MESSAGE_BYTES = 4_096;
const STELLAR_ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3;
const STELLAR_STRKEY_LENGTH = 56;
const STELLAR_STRKEY_DECODED_LENGTH = 35;
const STELLAR_STRKEY_PAYLOAD_LENGTH = 33;
const STELLAR_STRKEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Maximum allowed message size in bytes (issue #674).
 * Must match `MAX_MESSAGE_BYTES` in `src/ws/hub.ts` (4096).
 * Duplicated here to avoid a circular import between hub.ts and messageHandler.ts.
 */
export const MAX_MESSAGE_BYTES = 4_096;

// SEP-23 StrKey validation for Stellar Ed25519 public keys: base32 shape,
// version byte, and CRC16-XModem checksum.
function decodeStellarBase32(value: string): number[] | null {
  const bytes: number[] = [];
  let bits = 0;
  let current = 0;

  for (const char of value) {
    const digit = STELLAR_STRKEY_ALPHABET.indexOf(char);
    if (digit === -1) return null;

    current = (current << 5) | digit;
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return bytes;
}

function crc16XModem(bytes: readonly number[]): number {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc;
}

export function isValidStellarPublicKey(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length !== STELLAR_STRKEY_LENGTH || !STELLAR_PUBLIC_KEY_REGEX.test(candidate)) {
    return false;
  }

  const decoded = decodeStellarBase32(candidate);
  if (decoded === null || decoded.length !== STELLAR_STRKEY_DECODED_LENGTH) {
    return false;
  }

  if (decoded[0] !== STELLAR_ED25519_PUBLIC_KEY_VERSION_BYTE) {
    return false;
  }

  const payload = decoded.slice(0, STELLAR_STRKEY_PAYLOAD_LENGTH);
  const expectedChecksum = crc16XModem(payload);
  const actualChecksum = decoded[STELLAR_STRKEY_PAYLOAD_LENGTH]!
    | (decoded[STELLAR_STRKEY_PAYLOAD_LENGTH + 1]! << 8);

  return expectedChecksum === actualChecksum;
}

const streamIdSchema = z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH);
const recipientAddressSchema = z
  .string()
  .trim()
  .regex(STELLAR_PUBLIC_KEY_REGEX, 'recipient_address must be a valid Stellar public key')
  .refine(isValidStellarPublicKey, 'recipient_address must be a valid Stellar StrKey public key');

/**
 * WebSocket Envelope Schemas
 *
 * We do not use `.passthrough()` on these schemas. By default, Zod strips any unknown fields.
 * This ensures the message shape is explicitly locked down inside the backend, preserving backward
 * compatibility for clients sending extra unrecognized fields (which will simply be stripped
 * rather than failing the validation), while preventing accidental bleeding of unvalidated data.
 */
const subscriptionFilterSchema = z.object({
  stream_id: streamIdSchema.optional(),
  streamId: streamIdSchema.optional(),
  recipient_address: recipientAddressSchema.optional(),
  recipientAddress: recipientAddressSchema.optional(),
  /** Opt-in micro-batching: coalesce rapid events for this stream into a single frame. */
  batching: z.boolean().optional(),
});

const subscriptionMessageSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  stream_id: streamIdSchema.optional(),
  streamId: streamIdSchema.optional(),
  recipient_address: recipientAddressSchema.optional(),
  recipientAddress: recipientAddressSchema.optional(),
  /** Opt-in micro-batching: coalesce rapid events for this stream into a single frame. */
  batching: z.boolean().optional(),
  filter: subscriptionFilterSchema.optional(),
});

const replayFilterSchema = z.object({
  afterEventId: z.string().trim().min(1).optional(),
  fromLedger: z.number().int().nonnegative().optional(),
  toledger: z.number().int().nonnegative().optional(),
  contractId: z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH).optional(),
  topic: z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const replayMessageSchema = z.object({
  type: z.literal('replay'),
  afterEventId: z.string().trim().min(1).optional(),
  fromLedger: z.number().int().nonnegative().optional(),
  toledger: z.number().int().nonnegative().optional(),
  contractId: z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH).optional(),
  topic: z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  filter: replayFilterSchema.optional(),
});

export interface SubscriptionFilter {
  streamId?: string;
  recipientAddress?: string;
  /**
   * When `true`, the hub will coalesce rapid events for this stream/recipient
   * into a single `stream_update_batch` frame per flush window instead of
   * sending one frame per event. Default: `false` (unchanged one-frame-per-event
   * behaviour).
   *
   * @see WS_BATCH_FLUSH_MS, WS_BATCH_MAX_SIZE env vars
   */
  batchingEnabled?: boolean;
}

export type WsClientMessage =
  | { type: 'subscribe'; filter: SubscriptionFilter }
  | { type: 'unsubscribe'; filter: SubscriptionFilter }
  | { type: 'replay'; filter: StreamEventReplayFilter };

export type WsMessageParseResult =
  | { ok: true; message: WsClientMessage }
  | { ok: false; code: 'UNKNOWN_TYPE' | 'INVALID_MESSAGE'; message: string };

export type HandshakeSubscriptionParseResult =
  | { ok: true; filter: SubscriptionFilter | null }
  | { ok: false; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstConsistentValue(values: Array<string | undefined>, field: string): string | undefined {
  const defined = values.filter((value): value is string => value !== undefined);
  if (defined.length === 0) return undefined;

  const [first] = defined;
  if (defined.some((value) => value !== first)) {
    throw new Error(`${field} aliases must not contain conflicting values`);
  }

  return first;
}

function normalizeSubscriptionFilter(
  value: z.infer<typeof subscriptionMessageSchema>,
): SubscriptionFilter {
  const streamId = firstConsistentValue(
    [
      value.stream_id,
      value.streamId,
      value.filter?.stream_id,
      value.filter?.streamId,
    ],
    'stream_id',
  );

  const recipientAddress = firstConsistentValue(
    [
      value.recipient_address,
      value.recipientAddress,
      value.filter?.recipient_address,
      value.filter?.recipientAddress,
    ],
    'recipient_address',
  );

  if (streamId !== undefined && recipientAddress !== undefined) {
    throw new Error('subscription filter accepts either stream_id or recipient_address, not both');
  }

  // Opt-in batching: top-level `batching` takes precedence over nested filter.batching.
  const batchingEnabled: boolean | undefined =
    value.batching ?? (value.filter?.batching as boolean | undefined);

  if (streamId !== undefined) return { streamId, ...(batchingEnabled !== undefined ? { batchingEnabled } : {}) };
  if (recipientAddress !== undefined) return { recipientAddress, ...(batchingEnabled !== undefined ? { batchingEnabled } : {}) };

  if (value.filter !== undefined) return {};

  throw new Error('subscribe and unsubscribe messages require stream_id, recipient_address, or an explicit empty filter');
}

function normalizeReplayFilter(value: z.infer<typeof replayMessageSchema>): StreamEventReplayFilter {
  return {
    ...((value.afterEventId ?? value.filter?.afterEventId) !== undefined ? { afterEventId: (value.afterEventId ?? value.filter?.afterEventId) } : {}),
    ...((value.fromLedger ?? value.filter?.fromLedger) !== undefined ? { fromLedger: (value.fromLedger ?? value.filter?.fromLedger) } : {}),
    ...((value.toledger ?? value.filter?.toledger) !== undefined ? { toledger: (value.toledger ?? value.filter?.toledger) } : {}),
    ...((value.contractId ?? value.filter?.contractId) !== undefined ? { contractId: (value.contractId ?? value.filter?.contractId) } : {}),
    ...((value.topic ?? value.filter?.topic) !== undefined ? { topic: (value.topic ?? value.filter?.topic) } : {}),
    ...((value.limit ?? value.filter?.limit) !== undefined ? { limit: (value.limit ?? value.filter?.limit) } : {}),
  };
}

function validationMessage(issues: z.ZodIssue[]): string {
  return issues[0]?.message ?? 'Invalid WebSocket message';
}

/**
 * Parse an inbound WebSocket control message from a client.
 *
 * This parser accepts both modern and aliased filter fields, including
 * nested `filter` objects, and normalizes them to a stable internal format.
 * Invalid messages are rejected with structured error codes.
 *
 * @param raw Parsed JSON value from the client frame.
 * @returns The normalized WebSocket client message or a validation error.
 */
export function validateWebSocketMessage(data: unknown, correlationId?: string): WsMessageParseResult {
  if (typeof data !== 'string') {
    logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'not_string' });
    return { ok: false, code: 'INVALID_MESSAGE', message: 'Message must be a string' };
  }

  const byteLength = Buffer.byteLength(data, 'utf8');
  if (byteLength > MAX_INBOUND_MESSAGE_BYTES) {
    logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'payload_too_large', byteLength });
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: `Message exceeds ${MAX_INBOUND_MESSAGE_BYTES} bytes (got ${byteLength})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'malformed_json' });
    return { ok: false, code: 'INVALID_MESSAGE', message: 'Invalid JSON' };
  }

  return parseWsClientMessage(parsed, correlationId);
}

export function parseWsClientMessage(raw: unknown, correlationId?: string): WsMessageParseResult {
  // Reject oversized payloads before any parsing (issue #674)
  const rawString = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (rawString && rawString.length > MAX_MESSAGE_BYTES) {
    logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'oversized_payload', size: rawString.length });
    return { 
      ok: false, 
      code: 'INVALID_MESSAGE', 
      message: `Message size ${rawString.length} exceeds maximum ${MAX_MESSAGE_BYTES} bytes` 
    };
  }

  if (!isObject(raw)) {
    logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'not_object' });
    return { ok: false, code: 'INVALID_MESSAGE', message: 'Message must be a JSON object' };
  }

  if (typeof raw.type !== 'string') {
    logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'missing_or_invalid_type' });
    return { ok: false, code: 'INVALID_MESSAGE', message: 'type must be a string' };
  }

  if (raw.type === 'subscribe' || raw.type === 'unsubscribe') {
    const result = subscriptionMessageSchema.safeParse(raw);
    if (!result.success) {
      logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'schema_validation', type: raw.type, issues: result.error.issues.map(i => i.message) });
      return { ok: false, code: 'INVALID_MESSAGE', message: validationMessage(result.error.issues) };
    }

    try {
      return {
        ok: true,
        message: {
          type: result.data.type,
          filter: normalizeSubscriptionFilter(result.data),
        },
      };
    } catch (error) {
      logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'normalize_error', type: raw.type });
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: error instanceof Error ? error.message : 'Invalid subscription filter',
      };
    }
  }

  if (raw.type === 'replay') {
    const result = replayMessageSchema.safeParse(raw);
    if (!result.success) {
      logger.warn('ws_envelope_reject', correlationId, { code: 'INVALID_MESSAGE', reason: 'schema_validation', type: 'replay', issues: result.error.issues.map(i => i.message) });
      return { ok: false, code: 'INVALID_MESSAGE', message: validationMessage(result.error.issues) };
    }

    return {
      ok: true,
      message: {
        type: 'replay',
        filter: normalizeReplayFilter(result.data),
      },
    };
  }

  logger.warn('ws_envelope_reject', correlationId, { code: 'UNKNOWN_TYPE', type: raw.type });
  return { ok: false, code: 'UNKNOWN_TYPE', message: `Unknown message type: ${raw.type}` };
}

export function parseHandshakeSubscriptionFilter(url: string, correlationId?: string): HandshakeSubscriptionParseResult {
  const params = new URL(url, 'ws://localhost').searchParams;
  const streamId = params.get('stream_id') ?? params.get('streamId');
  const recipientAddress = params.get('recipient_address') ?? params.get('recipientAddress');

  if (streamId === null && recipientAddress === null) {
    return { ok: true, filter: null };
  }

  const input: Record<string, unknown> = {
    type: 'subscribe',
  };
  if (streamId !== null) input['stream_id'] = streamId;
  if (recipientAddress !== null) input['recipient_address'] = recipientAddress;

  const result = parseWsClientMessage(input, correlationId);
  if (!result.ok) {
    logger.warn('ws_handshake_reject', correlationId, { reason: result.message });
    return { ok: false, message: result.message };
  }

  if (result.message.type !== 'subscribe') {
    return { ok: false, message: 'Handshake filter must be a subscribe filter' };
  }

  return { ok: true, filter: result.message.filter };
}
