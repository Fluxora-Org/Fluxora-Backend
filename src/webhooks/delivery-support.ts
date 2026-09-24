/** Shared validation, configuration, and failure-classification helpers for webhook delivery. */
import { logger } from '../lib/logger.js';
import { loadConfig } from '../config/env.js';
import type { WebhookDelivery, DLQReasonCode } from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';
import { webhookDeliveryStore } from './storeFactory.js';
import { isRetryableStatusCode, type EnhancedRetryPolicy } from './retry.js';
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header.trim(), 10);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  // Try parsing as HTTP-date
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - now);
  }
  return null;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveWebhookRetryPolicy(override?: EnhancedRetryPolicy): EnhancedRetryPolicy {
  const threshold = parseNonNegativeInteger(String(loadConfig().webhookCircuitBreakerThreshold), 0);
  const resetMs = parsePositiveInteger(String(loadConfig().webhookCircuitBreakerResetMs), 300_000);
  return {
    ...DEFAULT_RETRY_POLICY,
    ...(threshold > 0
      ? { circuitBreakerThreshold: threshold, circuitBreakerResetMs: resetMs }
      : {}),
    ...override,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function assertSafeWebhookEndpoint(endpointUrl: string): void {
  const url = new URL(endpointUrl);

  if (url.username || url.password) {
    throw new Error('Webhook endpoint must not include credentials');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Webhook endpoint must use http or https');
  }

  if (
    loadConfig().nodeEnv === 'production' &&
    url.protocol !== 'https:' &&
    !isLoopbackHostname(url.hostname)
  ) {
    throw new Error('Webhook endpoint must use https in production');
  }
}

export function normalizePayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }

  return payload;
}

export function extractAttemptNumber(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 1;
  const retry = (payload as Record<string, unknown>)['_webhookRetry'];
  if (typeof retry !== 'object' || retry === null) return 1;
  const attemptNumber = (retry as Record<string, unknown>)['attemptNumber'];
  return typeof attemptNumber === 'number' && Number.isFinite(attemptNumber) && attemptNumber > 0
    ? Math.floor(attemptNumber)
    : 1;
}

export function enqueuePermanentFailureToDlq(
  delivery: WebhookDelivery,
  failureReason: string,
  reasonCode: DLQReasonCode = 'other'
): string | undefined {
  const alreadyQueued = webhookDeliveryStore
    .getDeadLetterQueueItems()
    .some((item) => item.deliveryId === delivery.deliveryId);

  if (alreadyQueued) {
    logger.warn('Webhook permanent failure already exists in dead-letter queue', undefined, {
      deliveryId: delivery.deliveryId,
    });
    return undefined;
  }

  return webhookDeliveryStore.addToDeadLetterQueue(delivery, failureReason, reasonCode);
}

/**
 * Validate a webhook payload for structural integrity.
 *
 * A payload is considered structurally invalid if:
 * - It is a non-empty string that fails to parse as JSON (unless it's a simple string)
 * - It is excessively large (>10MB to prevent resource exhaustion)
 * - It appears to be binary garbage (contains non-UTF8 characters)
 *
 * @throws {string} Error message describing the validation failure, if the payload is poisoned
 */
export function validateWebhookPayload(payload: unknown): void {
  // Check if payload is oversized (potential DoS vector)
  if (typeof payload === 'string' && payload.length > 10 * 1024 * 1024) {
    throw 'Payload exceeds maximum size of 10MB (likely garbage or DoS attempt)';
  }

  // If it's a string, verify it's valid JSON or a reasonable simple string
  if (typeof payload === 'string') {
    // Try to parse as JSON first
    try {
      JSON.parse(payload);
      // Successfully parsed - this is valid JSON
      return;
    } catch {
      // Failed to parse. Check if this looks like an attempt at JSON (starts with { or [)
      const trimmed = payload.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // Looks like JSON but failed to parse - definitely poison
        throw `Payload starts with JSON marker but is not valid JSON`;
      }

      // If it's not JSON-like, check if it's binary garbage
      // Allow simple strings but reject if any character is outside printable ASCII range
      if (payload.length > 1000) {
        // Check if the first 100 chars contain any non-printable characters
        let hasNonPrintable = false;
        const checkStr = payload.substring(0, 100);
        for (let i = 0; i < checkStr.length; i++) {
          const code = checkStr.charCodeAt(i);
          // Allow printable ASCII (0x20-0x7E) and common whitespace (0x09, 0x0A, 0x0D)
          if (
            !((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d)
          ) {
            hasNonPrintable = true;
            break;
          }
        }
        if (hasNonPrintable) {
          throw 'Payload appears to be binary garbage (non-UTF8 characters detected)';
        }
      }
    }
  }
}

/**
 * Validate a webhook endpoint URL for structural integrity.
 *
 * A URL is considered invalid (poison) if:
 * - It cannot be parsed as a valid URL
 * - It uses an unsupported protocol (not http/https)
 * - It includes credentials (security risk)
 *
 * @throws {string} Error message describing the validation failure
 */
export function validateWebhookUrl(endpointUrl: string): void {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw `Webhook endpoint URL is unparseable: ${endpointUrl}`;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw `Webhook endpoint must use http or https, got: ${url.protocol}`;
  }

  if (url.username || url.password) {
    throw 'Webhook endpoint must not include credentials in URL';
  }
}

/**
 * Classify a delivery failure as "poison" (deterministic/non-retryable).
 *
 * A failure is poison if it will deterministically recur on every retry:
 * - Structurally invalid payload
 * - Unparseable endpoint URL
 * - Non-retryable HTTP status code (4xx except rate-limiting codes)
 *
 * Returns a DLQReasonCode to distinguish poison from exhausted retries.
 */
export function classifyPoisonFailure(
  payload: unknown,
  endpointUrl: string,
  statusCode: number | undefined,
  policy: EnhancedRetryPolicy,
  error?: string
): DLQReasonCode | null {
  if (error && error.includes('Webhook delivery timeout')) {
    return 'timeout';
  }

  // Check for structurally invalid payload
  try {
    validateWebhookPayload(payload);
  } catch {
    return 'poison';
  }

  // Check for unparseable URL
  try {
    validateWebhookUrl(endpointUrl);
  } catch {
    return 'poison';
  }

  // Check for non-retryable status codes (4xx except rate-limiting)
  if (statusCode !== undefined && !isRetryableStatusCode(statusCode, policy)) {
    if (statusCode >= 400 && statusCode < 500) {
      return 'poison';
    }
  }

  return null;
}
