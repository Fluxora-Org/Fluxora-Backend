/**
 * Webhook payload schemas — the published, versioned wire contract (issue #1570).
 *
 * `src/webhooks/types.ts` defines the payloads receivers parse, and those
 * shapes are an external contract: every receiver has code matching them.
 * That made them a contract nobody could see — an additive-looking change to
 * `types.ts` could break consumers silently. This module makes the contract
 * explicit:
 *
 *   - Each event type's payload is described by a zod schema, mirroring the
 *     exact shape the emit sites build (`streamEventService.ts`).
 *   - Every published payload carries a `schema_version` field, so receivers
 *     can tell which shape they are parsing.
 *   - The compatibility rule is stated once, here: ADDITIVE changes (new
 *     optional fields, new enum members) do NOT bump the version. Removing,
 *     renaming, retyping, or changing the semantics of an existing field DOES.
 *   - Committed fixtures (see `tests/webhooks/payloadSchemas.test.ts` and the
 *     JSON fixtures under `src/webhooks/schema-fixtures/`) pin the current
 *     shape of every event, so any shape change fails CI until the version is
 *     deliberately bumped.
 *
 * The three stream events are the payload types the webhook system currently
 * emits (`stream.created`, `stream.updated`, `stream.cancelled`).
 */

import { z } from 'zod';

/** Current published schema version. Bump on any breaking payload change. */
export const WEBHOOK_SCHEMA_VERSION = 1 as const;

/** The event types the webhook system emits, with their published schemas. */
export const WEBHOOK_EVENT_TYPES = [
  'stream.created',
  'stream.updated',
  'stream.cancelled',
] as const;

export type PublishedWebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Shared envelope fields every published payload carries. */
const envelopeFields = {
  event: z.enum(WEBHOOK_EVENT_TYPES),
  schema_version: z.number().int(),
};

/**
 * `stream.created` — emitted when a stream is first seen on chain. The body
 * mirrors `CreateStreamInput` as built in `streamEventService.processStreamCreated`.
 */
export const streamCreatedPayloadSchema = z
  .object({
    ...envelopeFields,
    id: z.string().min(1),
    sender_address: z.string().min(1),
    recipient_address: z.string().min(1),
    amount: z.string(),
    streamed_amount: z.string(),
    remaining_amount: z.string(),
    rate_per_second: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    contract_id: z.string().min(1),
    transaction_hash: z.string().min(1),
    event_index: z.number().int(),
  })
  .strict();

/**
 * `stream.updated` — emitted when a stream's on-chain state moves. The body
 * is `UpdateStreamInput` plus `event`/`schema_version`, exactly as built in
 * `streamEventService.processStreamUpdated` (fields present only when the
 * event carried them).
 */
export const streamUpdatedPayloadSchema = z
  .object({
    ...envelopeFields,
    status: z.string().optional(),
    streamed_amount: z.string().optional(),
    remaining_amount: z.string().optional(),
    end_time: z.number().optional(),
  })
  .strict();

/**
 * `stream.cancelled` — emitted when a stream is cancelled on chain. The body
 * is fixed: `{ status: 'cancelled' }` plus the envelope.
 */
export const streamCancelledPayloadSchema = z
  .object({
    ...envelopeFields,
    status: z.literal('cancelled'),
  })
  .strict();

/** All published payload schemas, keyed by event type. */
export const WEBHOOK_PAYLOAD_SCHEMAS: Record<
  PublishedWebhookEventType,
  z.ZodTypeAny
> = {
  'stream.created': streamCreatedPayloadSchema,
  'stream.updated': streamUpdatedPayloadSchema,
  'stream.cancelled': streamCancelledPayloadSchema,
};

/**
 * Validate a payload against its event type's published schema.
 *
 * Throws a descriptive error on mismatch so the poison path in
 * `delivery-support.ts` can surface WHY a payload is invalid, not just that
 * it is. Unknown event types are rejected: a receiver must never be handed a
 * payload nobody published a schema for.
 */
export function validatePublishedPayload(
  eventType: string,
  payload: unknown
): void {
  const schema = WEBHOOK_PAYLOAD_SCHEMAS[eventType as PublishedWebhookEventType];
  if (!schema) {
    throw new Error(
      `Unknown webhook event type "${eventType}": no published schema exists. ` +
        `Known types: ${WEBHOOK_EVENT_TYPES.join(', ')}.`
    );
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Webhook payload for "${eventType}" does not match published schema ` +
        `v${WEBHOOK_SCHEMA_VERSION} (breaking change requires a schema_version ` +
        `bump): ${issues}`
    );
  }
}
