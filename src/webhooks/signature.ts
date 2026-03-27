import { createHmac, timingSafeEqual } from 'node:crypto';

export const FLUXORA_WEBHOOK_HEADERS = {
  deliveryId: 'x-fluxora-delivery-id',
  timestamp: 'x-fluxora-timestamp',
  signature: 'x-fluxora-signature',
  eventType: 'x-fluxora-event',
} as const;

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

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
  | 'duplicate_delivery';

export type WebhookVerificationResult = {
  ok: boolean;
  status: 200 | 400 | 401 | 409 | 413;
  code: WebhookVerificationCode;
  message: string;
};

export type VerifyWebhookSignatureInput = {
  secret?: string;
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
) {
  const body = toBuffer(rawBody);
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
}

export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string | Buffer,
) {
  return createHmac('sha256', secret)
    .update(buildWebhookSigningPayload(timestamp, rawBody))
    .digest('hex');
}

export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookVerificationResult {
  const {
    secret,
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

  const expectedSignature = computeWebhookSignature(secret, timestamp, body);
  const actualSignature = signature.trim().toLowerCase();

  const matches = actualSignature.length === expectedSignature.length &&
    timingSafeEqual(
      Buffer.from(actualSignature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8'),
    );

  if (!matches) {
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
  };
}
