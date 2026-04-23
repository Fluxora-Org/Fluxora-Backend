/**
 * Sweep — liability-based accounting for safe token recovery.
 *
 * Invariant (enforced before every sweep):
 *   sweepable = contractBalance - outstandingLiabilities
 *
 * Outstanding liabilities are the sum of `remaining_amount` across every
 * stream that still owes tokens to a recipient:
 *   - active / paused / scheduled  → full remaining_amount is owed
 *   - cancelled with undrawn accrual → streamed_amount - withdrawn_amount is owed
 *   - completed awaiting close      → remaining_amount (recipient hasn't claimed yet)
 *
 * The sweep MUST NOT transfer more than `sweepable`. Attempting to do so
 * returns an error rather than a partial transfer, so the invariant is
 * never violated.
 */

import type { Stream } from '../routes/streams.js';

export interface SweepInput {
  /** Reported on-chain token balance of the contract address (decimal string). */
  contractBalance: string;
  /** All streams known to the service. */
  streams: Stream[];
}

export interface SweepResult {
  /** Maximum tokens that may safely be swept (decimal string). */
  sweepableAmount: string;
  /** Sum of all outstanding liabilities (decimal string). */
  totalLiabilities: string;
  /** Contract balance used for the calculation (decimal string). */
  contractBalance: string;
}

export interface SweepError {
  code: 'INSUFFICIENT_BALANCE' | 'INVALID_INPUT';
  message: string;
}

/**
 * Parse a decimal string to a BigInt in the smallest representable unit.
 * We use 7 decimal places (matching the project's maxScale) so all arithmetic
 * stays in integers and avoids floating-point drift.
 */
const SCALE = 7n;
const SCALE_FACTOR = 10n ** SCALE; // 10_000_000

function parseAmount(value: string, field: string): bigint {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty decimal string`);
  }
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{0,7}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`${field} is not a valid decimal string: "${trimmed}"`);
  }
  const intPart = BigInt(match[1] ?? '0');
  const fracStr = (match[2] ?? '').padEnd(7, '0');
  const fracPart = BigInt(fracStr);
  return intPart * SCALE_FACTOR + fracPart;
}

function formatAmount(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const intPart = abs / SCALE_FACTOR;
  const fracPart = abs % SCALE_FACTOR;
  const fracStr = fracPart.toString().padStart(7, '0');
  return `${negative ? '-' : ''}${intPart}.${fracStr}`;
}

/**
 * Statuses whose `remaining_amount` is fully owed to the recipient.
 * Cancelled streams are excluded here because their liability is only the
 * accrued-but-undrawn portion (streamed_amount), not the full remaining.
 */
const FULLY_OWED_STATUSES = new Set(['active', 'paused', 'scheduled', 'completed']);

/**
 * Calculate the outstanding liabilities and sweepable amount.
 *
 * @throws if any amount field cannot be parsed.
 */
export function calculateSweepable(input: SweepInput): SweepResult {
  const balance = parseAmount(input.contractBalance, 'contractBalance');

  let liabilities = 0n;

  for (const stream of input.streams) {
    if (FULLY_OWED_STATUSES.has(stream.status)) {
      // The full remaining_amount is still owed to the recipient.
      liabilities += parseAmount(stream.depositAmount, `stream[${stream.id}].depositAmount`);
    } else if (stream.status === 'cancelled') {
      // Only the accrued-but-undrawn portion is owed.
      // In the in-memory model, depositAmount is the total deposit and we
      // don't track withdrawn separately, so we conservatively treat the
      // entire depositAmount as a liability for cancelled streams that
      // haven't been fully settled. Operators can override by passing
      // streams with status 'completed' once settlement is confirmed.
      liabilities += parseAmount(stream.depositAmount, `stream[${stream.id}].depositAmount`);
    }
    // 'depleted' streams have no remaining liability (fully streamed out).
  }

  const sweepable = balance - liabilities < 0n ? 0n : balance - liabilities;

  return {
    sweepableAmount: formatAmount(sweepable),
    totalLiabilities: formatAmount(liabilities),
    contractBalance: formatAmount(balance),
  };
}

/**
 * Validate that a requested sweep amount does not exceed the sweepable amount.
 *
 * Returns `{ ok: true }` when safe, or `{ ok: false, error }` when the
 * invariant would be violated.
 */
export function validateSweepRequest(
  requestedAmount: string,
  sweepResult: SweepResult,
): { ok: true } | { ok: false; error: SweepError } {
  let requested: bigint;
  try {
    requested = parseAmount(requestedAmount, 'requestedAmount');
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const sweepable = parseAmount(sweepResult.sweepableAmount, 'sweepableAmount');

  if (requested > sweepable) {
    return {
      ok: false,
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message:
          `Requested sweep of ${requestedAmount} exceeds sweepable amount of ` +
          `${sweepResult.sweepableAmount} ` +
          `(balance ${sweepResult.contractBalance} − liabilities ${sweepResult.totalLiabilities}).`,
      },
    };
  }

  return { ok: true };
}
