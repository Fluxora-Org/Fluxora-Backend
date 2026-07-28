import { z } from 'zod';

/**
 * Zod schema validating the 409 Conflict response shape returned by the
 * idempotency middleware when a request is replayed with a different body.
 *
 * This contract is stable and used by clients to detect when an
 * Idempotency-Key is being reused incorrectly.
 */
export const IdempotencyConflictSchema = z.object({
  error: z.literal('idempotency_conflict'),
  stored_hash: z.string().length(64),
  incoming_hash: z.string().length(64),
});

export type IdempotencyConflict = z.infer<typeof IdempotencyConflictSchema>;
