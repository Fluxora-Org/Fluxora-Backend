/**
 * Webhook delivery environment variables.
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { z } from 'zod';
import { byteSizeToNumber, integerEnv, optionalString, optionalUrlString } from './parsers.js';

export const webhooksEnvSchema = {
  /** Delivery target for stream event webhooks. @default unset (webhooks disabled) */
  WEBHOOK_URL: optionalUrlString('WEBHOOK_URL'),
  /** HMAC secret signing webhook payloads. */
  WEBHOOK_SECRET: optionalString('WEBHOOK_SECRET'),
  /** Previous HMAC secret, still verified during rotation. */
  WEBHOOK_SECRET_PREVIOUS: optionalString('WEBHOOK_SECRET_PREVIOUS'),
  /** Fluxora-platform inbound webhook HMAC secret. */
  FLUXORA_WEBHOOK_SECRET: optionalString('FLUXORA_WEBHOOK_SECRET'),
  /** Previous Fluxora-platform webhook secret during rotation. */
  FLUXORA_WEBHOOK_SECRET_PREVIOUS: optionalString('FLUXORA_WEBHOOK_SECRET_PREVIOUS'),
  /** Poll interval for the webhook outbox dispatcher in ms. @default 10000 */
  WEBHOOK_POLL_INTERVAL_MS: integerEnv('WEBHOOK_POLL_INTERVAL_MS', 1).default(10000),
  /** Webhooks dispatched per outbox poll batch. @default 10 */
  WEBHOOK_BATCH_SIZE: integerEnv('WEBHOOK_BATCH_SIZE', 1, 1000).default(10),
  /** Cap of the exponential backoff between batch retries, in ms. @default 60000 */
  WEBHOOK_BATCH_MAX_BACKOFF_MS: integerEnv('WEBHOOK_BATCH_MAX_BACKOFF_MS', 1).default(60_000),
  /** Steady-state retry dispatch rate, webhooks/second. @default 10 */
  WEBHOOK_RETRY_RPS: integerEnv('WEBHOOK_RETRY_RPS', 1, 1000).default(10),
  /** Extra tokens allowed above the steady retry rate in a burst. @default 0 */
  WEBHOOK_RETRY_BURST: integerEnv('WEBHOOK_RETRY_BURST', 0).default(0),
  /** Consecutive failures before the circuit breaker opens; 0 disables. @default 0 */
  WEBHOOK_CIRCUIT_BREAKER_THRESHOLD: integerEnv(
    'WEBHOOK_CIRCUIT_BREAKER_THRESHOLD',
    0,
    1000
  ).default(0),
  /** Delay before a tripped circuit breaker half-opens, in ms. @default 300000 */
  WEBHOOK_CIRCUIT_BREAKER_RESET_MS: integerEnv('WEBHOOK_CIRCUIT_BREAKER_RESET_MS', 1).default(
    300_000
  ),
  /** Comma-separated SSRF allowlist of webhook hostnames. */
  WEBHOOK_ALLOWED_HOSTS: optionalString('WEBHOOK_ALLOWED_HOSTS'),
  /** Largest accepted response body per delivery, parsed from byte sizes. @default 65536 (64 KiB) */
  WEBHOOK_MAX_RESPONSE_BYTES: z
    .preprocess(
      byteSizeToNumber,
      z
        .number()
        .int('WEBHOOK_MAX_RESPONSE_BYTES must resolve to whole bytes')
        .positive('WEBHOOK_MAX_RESPONSE_BYTES must be positive')
    )
    .default(64 * 1024),
  /** DNS resolution timeout per webhook delivery in ms. @default 2000 */
  WEBHOOK_DNS_TIMEOUT_MS: integerEnv('WEBHOOK_DNS_TIMEOUT_MS', 1).default(2000),
};
