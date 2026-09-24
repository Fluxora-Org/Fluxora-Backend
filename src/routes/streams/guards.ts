/**
 * Request validation, authorization guards and error mapping for the streams
 * routes. Pure with respect to the database: nothing here issues a query.
 *
 * @module routes/streams/guards
 */
import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import {
  compareDecimalStringToZero,
  validateDecimalString,
  validateAmountFields,
} from '../../serialization/decimal.js';
import { ApiError } from '../../errors.js';
import {
  ApiErrorCode,
  validationError,
  serviceUnavailable,
  forbidden,
} from '../../middleware/errorHandler.js';
import { canonicalizeBody } from '../../middleware/idempotency.js';
import { SerializationLogger } from '../../utils/logger.js';
import { PoolExhaustedError } from '../../db/pool.js';
import { StatusConflictError } from '../../db/repositories/streamRepository.js';
import type { ApiCreateStreamInput } from '../../db/repositories/streamApiQueries.js';
import { CreateStreamSchema, parseBody, formatZodIssues } from '../../validation/schemas.js';
import type { ApiStreamStatus } from '../../streams/status.js';

const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'];

export const API_STREAM_STATUS_VALUES: readonly ApiStreamStatus[] = ['active', 'paused', 'completed', 'cancelled'];

/**
 * Validate and sanitise the Last-Event-ID header value.
 *
 * Security: rejects control characters (CR/LF/NUL), whitespace-only values,
 * and values exceeding 200 characters. The allowed character set is printable
 * ASCII 0x21–0x7E which excludes space (0x20) and all control characters.
 *
 * Returns the trimmed, validated value or throws a validationError.
 * Returns `undefined` when the header is absent (no replay requested).
 *
 * Exported for unit testing — the HTTP parser strips control characters from
 * headers in transit, so integration tests cannot cover CR/LF/NUL paths.
 */
export function parseLastEventIdHeader(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw validationError('Last-Event-ID must be a string');
  }
  // Validate the raw value BEFORE trimming so control characters in the value
  // (CR, LF, NUL, etc.) are caught — trim() would strip trailing CR/LF.
  if (raw.trim() === '') {
    throw validationError('Last-Event-ID must not be empty or whitespace-only');
  }
  if (!/^[\x21-\x7E]+$/.test(raw)) {
    throw validationError('Last-Event-ID contains invalid characters or exceeds the 200-character limit');
  }
  const trimmed = raw.trim();
  if (trimmed.length > 200) {
    throw validationError('Last-Event-ID contains invalid characters or exceeds the 200-character limit');
  }
  return trimmed;
}

// Long-poll `timeout` query param semantics (locked down for #1065):
//
//   - A raw value STRICTLY GREATER THAN this threshold is interpreted as
//     milliseconds (e.g. ?timeout=5000 -> 5s).
//   - A raw value at or below this threshold is interpreted as seconds
//     (e.g. ?timeout=5 -> 5s; ?timeout=1000 -> 1000s, then clamped by the caller).
//
// This dual interpretation is a pre-existing, intentionally preserved
// contract for backward compatibility with existing clients.
const TIMEOUT_MS_INTERPRETATION_THRESHOLD = 1000;
// Guard against pathological input (e.g. a 300-digit numeric string) before it
// ever reaches Number.parseInt, so the interpretation above cannot be bypassed.
const MAX_TIMEOUT_INPUT_DIGITS = 15;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 30_000;

/** Parse the long-poll `timeout` query param into unclamped milliseconds. */
export function parseLongPollTimeoutMs(rawTimeout: unknown): number {
  if (rawTimeout === undefined) return DEFAULT_LONG_POLL_TIMEOUT_MS;
  if (
    typeof rawTimeout !== 'string' ||
    !/^\d+$/.test(rawTimeout) ||
    rawTimeout.length > MAX_TIMEOUT_INPUT_DIGITS
  ) {
    throw validationError('timeout must be a positive integer');
  }
  const parsedTimeout = Number.parseInt(rawTimeout, 10);
  if (parsedTimeout < 1) {
    throw validationError('timeout must be at least 1 second');
  }
  return parsedTimeout > TIMEOUT_MS_INTERPRETATION_THRESHOLD ? parsedTimeout : parsedTimeout * 1000;
}

function normalizeCreateInput(body: Record<string, unknown>): ApiCreateStreamInput {
  const parseResult = parseBody(CreateStreamSchema, body);

  if (!parseResult.success) {
    const formatted = formatZodIssues(parseResult.issues);
    throw new ApiError(
      400,
      ApiErrorCode.VALIDATION_ERROR,
      formatted[0]?.message ?? 'Validation failed',
      formatted.map((e) => e.message).join('; '),
    );
  }

  const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } =
    parseResult.data as ApiCreateStreamInput;

  const amountValidation = validateAmountFields({ depositAmount, ratePerSecond }, AMOUNT_FIELDS);
  if (!amountValidation.valid) {
    throw new ApiError(
      400,
      ApiErrorCode.VALIDATION_ERROR,
      'Invalid decimal string format for amount fields',
      { errors: amountValidation.errors.map((e) => ({ field: e.field, code: e.code, message: e.message })) },
    );
  }

  const depositResult = validateDecimalString(depositAmount ?? '0', 'depositAmount');
  const validatedDeposit = depositResult.valid && depositResult.value ? depositResult.value : '0';
  if (compareDecimalStringToZero(validatedDeposit) <= 0) {
    throw validationError('depositAmount must be greater than zero');
  }

  const rateResult = validateDecimalString(ratePerSecond ?? '0', 'ratePerSecond');
  const validatedRate = rateResult.valid && rateResult.value ? rateResult.value : '0';
  if (ratePerSecond !== undefined && compareDecimalStringToZero(validatedRate) < 0) {
    throw validationError('ratePerSecond cannot be negative');
  }

  // Key order is significant: the create query derives the stream id from it.
  return {
    sender: sender.trim(),
    recipient: recipient.trim(),
    depositAmount: validatedDeposit,
    ratePerSecond: validatedRate,
    startTime: startTime ?? Math.floor(Date.now() / 1000),
    endTime: endTime ?? 0,
  };
}

/**
 * Validate a create body, logging each malformed amount field through the
 * serialization logger before the validation error propagates.
 */
export function parseCreateStreamBody(body: unknown, requestId?: string): ApiCreateStreamInput {
  const fields = (body ?? {}) as Record<string, unknown>;
  try {
    return normalizeCreateInput(fields);
  } catch (error) {
    const av = validateAmountFields(
      { depositAmount: fields['depositAmount'], ratePerSecond: fields['ratePerSecond'] },
      AMOUNT_FIELDS,
    );
    if (!av.valid) {
      for (const err of av.errors) {
        SerializationLogger.validationFailed(err.field || 'unknown', err.rawValue, err.code, requestId);
      }
    }
    throw error;
  }
}

export function fingerprintInput(input: ApiCreateStreamInput): string {
  return crypto.createHash('sha256').update(canonicalizeBody(input)).digest('hex');
}

/**
 * Resolve a stable rollout identity for feature flag bucketing.
 *
 * @security API-key authenticated requests prefer the server-side key id. When
 * that is not available, raw X-API-Key header material is used only as input to
 * the feature flag hash and is never logged or included in responses.
 */
export function getFeatureFlagRequesterId(req: Request): string {
  const keyId = (req as Request & { keyId?: unknown }).keyId;
  if (typeof keyId === 'string' && keyId.trim() !== '') {
    return `key:${keyId}`;
  }

  const rawApiKey = req.headers['x-api-key'];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    return `api-key:${apiKey.trim()}`;
  }

  return `ip:${req.ip ?? 'anonymous'}`;
}

/**
 * Middleware to enforce stream visibility based on JWT roles and addresses.
 * Operators bypass scoping; everyone else has their address attached as
 * `req.callerAddress` for downstream authorization checks.
 */
export function enforceStreamScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role === 'operator') {
    return next();
  }

  const callerAddress = req.user.address as string | undefined;
  if (!callerAddress) {
    // Should not happen if authenticate middleware is working, but safe fail.
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Caller address missing' } });
    return;
  }

  req.callerAddress = callerAddress;
  next();
}

/** Scoped callers may only list streams where they are the sender or recipient. */
export function assertCallerMayList(
  callerAddress: string | undefined,
  sender: string | undefined,
  recipient: string | undefined,
): void {
  if (!callerAddress) return;
  if (!sender && !recipient) {
    throw forbidden('Scoped users must filter by sender or recipient matching their address');
  }
  if (sender && sender !== callerAddress) {
    throw forbidden('You are not authorized to query streams for this sender');
  }
  if (recipient && recipient !== callerAddress) {
    throw forbidden('You are not authorized to query streams for this recipient');
  }
}

// ── API status state machine ──────────────────────────────────────────────────

const API_TRANSITIONS: Record<ApiStreamStatus, ApiStreamStatus[]> = {
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

function transitionError(from: ApiStreamStatus, to: ApiStreamStatus): string | undefined {
  const allowed = API_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return undefined;
  if (from === to) return `Stream is already ${from}`;
  if (from === 'completed') return 'Stream is already completed and cannot be transitioned';
  if (from === 'cancelled') return 'Stream is already cancelled and cannot be transitioned';
  return `Cannot transition stream from '${from}' to '${to}'`;
}

/** Throw 409 CONFLICT when the state machine forbids `from → to`. */
export function assertApiTransition(
  id: string,
  from: string,
  to: ApiStreamStatus,
  options: { includeRequestedStatus: boolean },
): void {
  const message = transitionError(from as ApiStreamStatus, to);
  if (message === undefined) return;
  throw new ApiError(409, ApiErrorCode.CONFLICT, message, {
    streamId: id,
    currentStatus: from,
    ...(options.includeRequestedStatus ? { requestedStatus: to } : {}),
  });
}

/** Map pool exhaustion to 503; rethrow everything else unchanged. */
export function rethrowDbError(err: unknown): never {
  if (err instanceof PoolExhaustedError) {
    throw serviceUnavailable('Database is temporarily unavailable. Please retry shortly.');
  }
  throw err;
}

export async function withDbErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    return rethrowDbError(err);
  }
}

/**
 * Run a status update, mapping a concurrent-modification conflict to 409 and
 * pool exhaustion to 503.
 */
export async function withStatusConflicts<T>(
  id: string,
  currentStatus: string,
  requestedStatus: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof StatusConflictError) {
      throw new ApiError(409, ApiErrorCode.CONFLICT, err.message, {
        streamId: id,
        currentStatus,
        requestedStatus,
      });
    }
    return rethrowDbError(err);
  }
}
