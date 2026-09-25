/**
 * Compatibility facade for webhook services.
 *
 * Delivery and outbox orchestration are implemented in focused modules; this
 * entrypoint preserves the historic imports used by routes and consumers.
 */
export { WebhookService } from './delivery.js';
export type { WebhookDispatcherOptions } from './outbox-dispatcher.js';
export { WebhookDispatcher } from './outbox-dispatcher.js';
import { WebhookService } from './delivery.js';
import { WebhookDispatcher } from './outbox-dispatcher.js';

export const webhookService = new WebhookService();
export const webhookDispatcher = new WebhookDispatcher();
