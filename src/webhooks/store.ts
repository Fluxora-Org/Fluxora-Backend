/**
 * In-memory webhook delivery store
 * In production, this would be backed by a database
 */

import type { WebhookDelivery, WebhookDeliveryStatus } from './types.js';

export class WebhookDeliveryStore {
  private deliveries: Map<string, WebhookDelivery> = new Map();
  private deliveryIdIndex: Map<string, string> = new Map(); // deliveryId -> id

  /**
   * Store a webhook delivery record
   */
  store(delivery: WebhookDelivery): void {
    this.deliveries.set(delivery.id, delivery);
    this.deliveryIdIndex.set(delivery.deliveryId, delivery.id);
  }

  /**
   * Get a delivery by its ID
   */
  get(id: string): WebhookDelivery | undefined {
    return this.deliveries.get(id);
  }

  /**
   * Get a delivery by its deliveryId (for deduplication)
   */
  getByDeliveryId(deliveryId: string): WebhookDelivery | undefined {
    const id = this.deliveryIdIndex.get(deliveryId);
    return id ? this.deliveries.get(id) : undefined;
  }

  /**
   * Update delivery status
   */
  updateStatus(id: string, status: WebhookDeliveryStatus): void {
    const delivery = this.deliveries.get(id);
    if (delivery) {
      delivery.status = status;
      delivery.updatedAt = Date.now();
    }
  }

  /**
   * Get all pending deliveries that are ready for retry
   */
  getPendingRetries(now: number = Date.now()): WebhookDelivery[] {
    const retries: WebhookDelivery[] = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.status === 'pending') {
        const lastAttempt = delivery.attempts[delivery.attempts.length - 1];
        if (lastAttempt?.nextRetryAt && lastAttempt.nextRetryAt <= now) {
          retries.push(delivery);
        }
      }
    }
    return retries;
  }

  /**
   * Get all deliveries for an event
   */
  getByEventId(eventId: string): WebhookDelivery[] {
    const results: WebhookDelivery[] = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.eventId === eventId) {
        results.push(delivery);
      }
    }
    return results;
  }

  /**
   * Check if a delivery ID has been seen before (for deduplication)
   */
  isDuplicateDelivery(deliveryId: string): boolean {
    return this.deliveryIdIndex.has(deliveryId);
  }

  /**
   * Clear all deliveries (for testing)
   */
  clear(): void {
    this.deliveries.clear();
    this.deliveryIdIndex.clear();
  }

  /**
   * Get all deliveries (for testing/monitoring)
   */
  getAll(): WebhookDelivery[] {
    return Array.from(this.deliveries.values());
  }
}

export const webhookDeliveryStore = new WebhookDeliveryStore();
