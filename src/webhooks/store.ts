/**
 * Enhanced webhook delivery store with durable storage, outbox pattern, and dead-letter queue
 * In production, this would be backed by a database like PostgreSQL
 */

import type { WebhookDelivery, WebhookDeliveryStatus } from './types.js';
import type { EnhancedRetryPolicy } from './retry.js';
import { shouldSendToDLQ } from './retry.js';
import { logger } from '../lib/logger.js';

export interface DeadLetterQueueItem {
  id: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  endpointUrl: string;
  payload: string;
  originalDelivery: WebhookDelivery;
  failureReason: string;
  createdAt: number;
  processedAt?: number;
}

export interface OutboxItem {
  id: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  endpointUrl: string;
  payload: string;
  secret: string;
  priority: 'high' | 'normal' | 'low';
  createdAt: number;
  scheduledFor: number;
  attempts: number;
  maxAttempts: number;
}

export interface CircuitBreakerState {
  endpointUrl: string;
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureTime: number;
  nextAttemptTime: number;
}

export class WebhookDeliveryStore {
  // Main delivery storage
  private deliveries: Map<string, WebhookDelivery> = new Map();
  private deliveryIdIndex: Map<string, string> = new Map();

  // Outbox pattern for reliable delivery
  private outbox: Map<string, OutboxItem> = new Map();
  private outboxPriorityQueue: Map<string, OutboxItem[]> = new Map();

  // Dead-letter queue for failed deliveries
  private deadLetterQueue: Map<string, DeadLetterQueueItem> = new Map();

  // Circuit breaker state per endpoint
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();

  // Metrics
  private metrics = {
    totalDeliveries: 0,
    successfulDeliveries: 0,
    failedDeliveries: 0,
    dlqItems: 0,
    outboxItems: 0,
  };

  /**
   * Store a webhook delivery record
   */
  store(delivery: WebhookDelivery): void {
    this.deliveries.set(delivery.id, delivery);
    this.deliveryIdIndex.set(delivery.deliveryId, delivery.id);
    this.metrics.totalDeliveries++;
    
    logger.debug('Webhook delivery stored', {
      deliveryId: delivery.deliveryId,
      status: delivery.status,
    });
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
   * Update delivery status and track metrics
   */
  updateStatus(id: string, status: WebhookDeliveryStatus): void {
    const delivery = this.deliveries.get(id);
    if (delivery) {
      const oldStatus = delivery.status;
      delivery.status = status;
      delivery.updatedAt = Date.now();

      // Update metrics
      if (oldStatus !== 'delivered' && status === 'delivered') {
        this.metrics.successfulDeliveries++;
      } else if (oldStatus !== 'permanent_failure' && status === 'permanent_failure') {
        this.metrics.failedDeliveries++;
      }

      logger.debug('Webhook delivery status updated', {
        deliveryId: delivery.deliveryId,
        oldStatus,
        newStatus: status,
      });
    }
  }

  /**
   * Add item to outbox for reliable delivery
   */
  addToOutbox(item: Omit<OutboxItem, 'id'>): string {
    const id = `outbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const outboxItem: OutboxItem = { ...item, id };
    
    this.outbox.set(id, outboxItem);
    
    // Add to priority queue
    const priority = outboxItem.priority;
    if (!this.outboxPriorityQueue.has(priority)) {
      this.outboxPriorityQueue.set(priority, []);
    }
    this.outboxPriorityQueue.get(priority)!.push(outboxItem);
    
    this.metrics.outboxItems++;
    
    logger.info('Item added to webhook outbox', {
      outboxId: id,
      deliveryId: item.deliveryId,
      priority,
      scheduledFor: new Date(item.scheduledFor).toISOString(),
    });
    
    return id;
  }

  /**
   * Get items from outbox that are ready for processing
   */
  getReadyOutboxItems(now: number = Date.now()): OutboxItem[] {
    const readyItems: OutboxItem[] = [];
    
    // Process by priority: high -> normal -> low
    const priorities = ['high', 'normal', 'low'];
    
    for (const priority of priorities) {
      const items = this.outboxPriorityQueue.get(priority) || [];
      const ready = items.filter(item => item.scheduledFor <= now && item.attempts < item.maxAttempts);
      readyItems.push(...ready);
    }
    
    return readyItems.sort((a, b) => a.scheduledFor - b.scheduledFor);
  }

  /**
   * Remove item from outbox
   */
  removeFromOutbox(id: string): boolean {
    const item = this.outbox.get(id);
    if (!item) return false;
    
    this.outbox.delete(id);
    
    // Remove from priority queue
    const priorityItems = this.outboxPriorityQueue.get(item.priority);
    if (priorityItems) {
      const index = priorityItems.findIndex(i => i.id === id);
      if (index !== -1) {
        priorityItems.splice(index, 1);
      }
    }
    
    this.metrics.outboxItems--;
    return true;
  }

  /**
   * Update outbox item attempt count
   */
  updateOutboxItemAttempt(id: string, attempts: number): void {
    const item = this.outbox.get(id);
    if (item) {
      item.attempts = attempts;
    }
  }

  /**
   * Add failed delivery to dead-letter queue
   */
  addToDeadLetterQueue(delivery: WebhookDelivery, failureReason: string): string {
    const id = `dlq_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const dlqItem: DeadLetterQueueItem = {
      id,
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      endpointUrl: delivery.endpointUrl,
      payload: delivery.payload,
      originalDelivery: delivery,
      failureReason,
      createdAt: Date.now(),
    };
    
    this.deadLetterQueue.set(id, dlqItem);
    this.metrics.dlqItems++;
    
    logger.error('Webhook delivery moved to dead-letter queue', {
      dlqId: id,
      deliveryId: delivery.deliveryId,
      failureReason,
      attemptCount: delivery.attempts.length,
    });
    
    return id;
  }

  /**
   * Get items from dead-letter queue
   */
  getDeadLetterQueueItems(limit?: number): DeadLetterQueueItem[] {
    const items = Array.from(this.deadLetterQueue.values());
    return limit ? items.slice(0, limit) : items;
  }

  /**
   * Process dead-letter queue item (retry or manual handling)
   */
  processDeadLetterQueueItem(id: string, processedAt: number = Date.now()): boolean {
    const item = this.deadLetterQueue.get(id);
    if (!item) return false;
    
    item.processedAt = processedAt;
    this.deadLetterQueue.delete(id);
    this.metrics.dlqItems--;
    
    logger.info('Dead-letter queue item processed', {
      dlqId: id,
      deliveryId: item.deliveryId,
      processedAt: new Date(processedAt).toISOString(),
    });
    
    return true;
  }

  /**
   * Get circuit breaker state for endpoint
   */
  getCircuitBreakerState(endpointUrl: string): CircuitBreakerState | undefined {
    return this.circuitBreakers.get(endpointUrl);
  }

  /**
   * Update circuit breaker state
   */
  updateCircuitBreakerState(
    endpointUrl: string,
    success: boolean,
    policy: EnhancedRetryPolicy,
  ): CircuitBreakerState {
    const now = Date.now();
    let state = this.circuitBreakers.get(endpointUrl);
    
    if (!state) {
      state = {
        endpointUrl,
        state: 'closed',
        failureCount: 0,
        lastFailureTime: 0,
        nextAttemptTime: 0,
      };
      this.circuitBreakers.set(endpointUrl, state);
    }
    
    if (success) {
      // Reset on success
      state.failureCount = 0;
      state.state = 'closed';
    } else {
      state.failureCount++;
      state.lastFailureTime = now;
      
      // Check if we should open the circuit breaker
      if (policy.circuitBreakerThreshold && 
          state.failureCount >= policy.circuitBreakerThreshold) {
        state.state = 'open';
        state.nextAttemptTime = now + (policy.circuitBreakerResetMs || 300000); // Default 5 minutes
      }
    }
    
    return state;
  }

  /**
   * Check if endpoint is available (circuit breaker logic)
   */
  isEndpointAvailable(endpointUrl: string): boolean {
    const state = this.circuitBreakers.get(endpointUrl);
    if (!state) return true;
    
    const now = Date.now();
    
    switch (state.state) {
      case 'closed':
        return true;
      case 'open':
        if (now >= state.nextAttemptTime) {
          state.state = 'half-open';
          return true;
        }
        return false;
      case 'half-open':
        return true;
      default:
        return true;
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
          // Check circuit breaker
          if (this.isEndpointAvailable(delivery.endpointUrl)) {
            retries.push(delivery);
          }
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
   * Get store metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Clean up old data (for maintenance)
   */
  cleanup(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): { cleaned: number; errors: string[] } {
    const now = Date.now();
    const cutoff = now - olderThanMs;
    let cleaned = 0;
    const errors: string[] = [];

    try {
      // Clean up old successful deliveries
      for (const [id, delivery] of this.deliveries.entries()) {
        if (delivery.status === 'delivered' && delivery.updatedAt < cutoff) {
          this.deliveries.delete(id);
          this.deliveryIdIndex.delete(delivery.deliveryId);
          cleaned++;
        }
      }

      // Clean up old DLQ items
      for (const [id, item] of this.deadLetterQueue.entries()) {
        if (item.createdAt < cutoff) {
          this.deadLetterQueue.delete(id);
          cleaned++;
        }
      }

      logger.info('Webhook store cleanup completed', { cleaned, olderThanMs });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return { cleaned, errors };
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.deliveries.clear();
    this.deliveryIdIndex.clear();
    this.outbox.clear();
    this.outboxPriorityQueue.clear();
    this.deadLetterQueue.clear();
    this.circuitBreakers.clear();
    
    this.metrics = {
      totalDeliveries: 0,
      successfulDeliveries: 0,
      failedDeliveries: 0,
      dlqItems: 0,
      outboxItems: 0,
    };
  }

  /**
   * Get all deliveries (for testing/monitoring)
   */
  getAll(): WebhookDelivery[] {
    return Array.from(this.deliveries.values());
  }

  /**
   * Get all outbox items (for testing/monitoring)
   */
  getAllOutboxItems(): OutboxItem[] {
    return Array.from(this.outbox.values());
  }

  /**
   * Get all circuit breaker states (for monitoring)
   */
  getAllCircuitBreakerStates(): CircuitBreakerState[] {
    return Array.from(this.circuitBreakers.values());
  }
}

export const webhookDeliveryStore = new WebhookDeliveryStore();
