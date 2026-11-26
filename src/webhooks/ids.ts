import { randomUUID } from 'node:crypto';

type WebhookIdPrefix = 'outbox' | 'dlq' | 'deliv';

export function newId(prefix: WebhookIdPrefix): string {
  return `${prefix}_${Date.now()}_${randomUUID()}`;
}
