import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_COMPARE_KEY = 'fluxora-webhook-sig';

function constantTimeCompare(a: string, b: string): boolean {
  const hashA = createHmac('sha256', SIG_COMPARE_KEY).update(a).digest('hex');
  const hashB = createHmac('sha256', SIG_COMPARE_KEY).update(b).digest('hex');
  return timingSafeEqual(Buffer.from(hashA, 'utf8'), Buffer.from(hashB, 'utf8'));
}

export const FLUXORA_WEBHOOK_HEADERS = {
  deliveryId: 'x-fluxora-delivery-id',
  timestamp: 'x-fluxora-timestamp',
  signature: 'x-fluxora-signature',
  eventType: 'x-fluxora-event',
} as const;

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * Default grace window (in seconds) during which a rotated-out secret remains
 * valid for incoming webhook verification. 24 hours gives producers a full
 * day to finish signing with the new secret before the old one is rejected.
 */
export const DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS = 86_400;

export type WebhookVerificationCode =
  | 'ok'
  | 'missing_secret'
  | 'missing_delivery_id'
  | 'missing_timestamp'
  | 'missing_signature'
  | 'payload_too_large'
  | 'invalid_timestamp'
  | 'timestamp_outside_tolerance'
  | 'signature_mismatch'
  | 'duplicate_delivery'
  | 'previous_secret_expired';

export type WebhookVerificationResult = {
  ok: boolean;
  status: 200 | 400 | 401 | 409 | 413;
  code: WebhookVerificationCode;
  message: string;
  /** True when the previous (rotating-out) secret matched instead of the current one. */
  usedPreviousSecret?: boolean;
};

export type VerifyWebhookSignatureInput = {
  secret?: string;
  /** Previous secret kept valid during rotation window. */
  secretPrevious?: string;
  /**
   * Unix timestamp (seconds) when the previous secret was rotated out.
   * When provided together with `graceWindowSeconds`, the previous secret is
   * only accepted for `graceWindowSeconds` after this timestamp; afterwards it
   * is rejected with `previous_secret_expired`. When omitted, the previous
   * secret is accepted unconditionally (backward compatibility).
   */
  previousSecretRotatedAt?: number;
  /**
   * Bounded grace window (seconds) during which the previous secret remains
   * valid. Defaults to {@link DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS}.
   * Only consulted when `previousSecretRotatedAt` is also provided.
   */
  graceWindowSeconds?: number;
  deliveryId?: string;
  timestamp?: string;
  signature?: string;
  rawBody: string | Buffer;
  toleranceSeconds?: number;
  now?: number | Date;
  maxBodyBytes?: number;
  isDuplicateDelivery?: (deliveryId: string) => boolean;
};

function toBuffer(rawBody: string | Buffer) {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
}

function toUnixSeconds(value: number | Date) {
  return value instanceof Date ? Math.floor(value.getTime() / 1000) : Math.floor(value);
}

export function buildWebhookSigningPayload(
  timestamp: string,
  rawBody: string | Buffer,
): Buffer {
  const body = toBuffer(rawBody);
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
}

export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string | Buffer,
): string {
  return createHmac('sha256', secret)
    .update(buildWebhookSigningPayload(timestamp, rawBody))
    .digest('hex');
}

export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookVerificationResult {
  const {
    secret,
    secretPrevious,
    previousSecretRotatedAt,
    graceWindowSeconds = DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS,
    deliveryId,
    timestamp,
    signature,
    rawBody,
    toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    now = Math.floor(Date.now() / 1000),
    maxBodyBytes = DEFAULT_MAX_WEBHOOK_BODY_BYTES,
    isDuplicateDelivery,
  } = input;

  const body = toBuffer(rawBody);

  if (!secret) {
    return {
      ok: false,
      status: 401,
      code: 'missing_secret',
      message: 'Webhook secret is required',
    };
  }

  if (!deliveryId) {
    return {
      ok: false,
      status: 401,
      code: 'missing_delivery_id',
      message: `Missing ${FLUXORA_WEBHOOK_HEADERS.deliveryId} header`,
    };
  }

  if (!timestamp) {
    return {
      ok: false,
      status: 401,
      code: 'missing_timestamp',
      message: `Missing ${FLUXORA_WEBHOOK_HEADERS.timestamp} header`,
    };
  }

  if (!signature) {
    return {
      ok: false,
      status: 401,
      code: 'missing_signature',
      message: `Missing ${FLUXORA_WEBHOOK_HEADERS.signature} header`,
    };
  }

  if (body.byteLength > maxBodyBytes) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: `Payload exceeds ${maxBodyBytes} bytes`,
    };
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber) || timestampNumber <= 0) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_timestamp',
      message: 'Timestamp must be a positive Unix seconds value',
    };
  }

  if (Math.abs(toUnixSeconds(now) - timestampNumber) > toleranceSeconds) {
    return {
      ok: false,
      status: 401,
      code: 'timestamp_outside_tolerance',
      message: `Timestamp is outside the ${toleranceSeconds} second verification window`,
    };
  }

  const actualSignature = signature.trim().toLowerCase();

  // Determine whether the previous secret is within its bounded grace window.
  // When previousSecretRotatedAt is provided, the previous secret is only
  // accepted for `graceWindowSeconds` after the rotation timestamp. After the
  // window expires the previous secret is rejected to prevent indefinite
  // acceptance of a stale secret. When previousSecretRotatedAt is omitted the
  // previous secret is accepted unconditionally (backward compatibility).
  const previousSecretExpired =
    secretPrevious !== undefined && previousSecretRotatedAt !== undefined
      ? toUnixSeconds(now) - previousSecretRotatedAt > graceWindowSeconds
      : false;

  // Build the list of secrets to try. The previous secret is only included
  // when it is within the grace window (or when no rotation timestamp was
  // provided, preserving backward compatibility).
  const secrets: Array<{ value: string; isPrevious: boolean }> = [
    { value: secret, isPrevious: false },
    ...(secretPrevious && !previousSecretExpired
      ? [{ value: secretPrevious, isPrevious: true }]
      : []),
  ];

  let matched = false;
  let usedPreviousSecret = false;

  for (const { value, isPrevious } of secrets) {
    const expected = computeWebhookSignature(value, timestamp, body);
    if (constantTimeCompare(actualSignature, expected)) {
      matched = true;
      usedPreviousSecret = isPrevious;
      break;
    }
  }

  if (!matched) {
    // If the previous secret was provided but has expired, surface a dedicated
    // code so operators can distinguish "stale secret" from "wrong secret".
    if (previousSecretExpired) {
      return {
        ok: false,
        status: 401,
        code: 'previous_secret_expired',
        message: 'Previous webhook secret has expired; rotate to the current secret',
      };
    }
    return {
      ok: false,
      status: 401,
      code: 'signature_mismatch',
      message: 'Webhook signature verification failed',
    };
  }

  if (isDuplicateDelivery?.(deliveryId)) {
    return {
      ok: false,
      status: 409,
      code: 'duplicate_delivery',
      message: 'Duplicate delivery id',
    };
  }

  return {
    ok: true,
    status: 200,
    code: 'ok',
    message: 'Webhook signature verified',
    ...(usedPreviousSecret ? { usedPreviousSecret: true } : {}),
  };
}
