import { createHash } from 'node:crypto';

const URL_FIELDS = ['consumerUrl', 'endpointUrl', 'webhookUrl', 'url'];
const NESTED_FIELDS = ['originalDelivery', 'delivery', 'webhook', 'endpoint'];

/** Normalize a DLQ consumer endpoint to a stable http(s) URL string. */
export function normalizeDlqConsumerUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Hash the endpoint before storing it in audit metadata or Redis-style keys. */
export function hashDlqConsumerUrl(consumerUrl: string): string {
  return createHash('sha256').update(consumerUrl).digest('hex').slice(0, 16);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/**
 * Extract the target consumer URL from the DLQ payload shapes produced by the
 * webhook delivery store and the durable outbox dispatcher.
 */
export function extractDlqConsumerUrl(payload: unknown): string | undefined {
  const record = objectRecord(parsePayload(payload));
  if (!record) return undefined;

  for (const key of URL_FIELDS) {
    const url = normalizeDlqConsumerUrl(record[key]);
    if (url) return url;
  }

  for (const key of NESTED_FIELDS) {
    const nested = objectRecord(record[key]);
    if (!nested) continue;
    for (const urlKey of URL_FIELDS) {
      const url = normalizeDlqConsumerUrl(nested[urlKey]);
      if (url) return url;
    }
  }

  return undefined;
}
