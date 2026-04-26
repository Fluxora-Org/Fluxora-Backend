/**
 * Stream Event Service - Maps blockchain events to database records
 *
 * Handles ingestion of streaming events from Stellar Soroban RPC.
 * Implements idempotent processing, handles out-of-order events,
 * and ensures eventual consistency.
 *
 * @module services/streamEventService
 */

import { streamRepository } from "../db/repositories/streamRepository.js";
import { CreateStreamInput, StreamStatus } from "../db/types.js";
import { info, warn, error as logError, debug } from "../utils/logger.js";
import { getStreamHub } from "../ws/hub.js";

/**
 * Raw event types from Stellar Soroban RPC
 */
export interface StreamCreatedEvent {
  type: "StreamCreated";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  sender: string;
  recipient: string;
  amount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
}

export interface StreamUpdatedEvent {
  type: "StreamUpdated";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  streamId: string;
  streamedAmount?: string;
  remainingAmount?: string;
  status?: StreamStatus;
  endTime?: number;
}

export interface StreamCancelledEvent {
  type: "StreamCancelled";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  streamId: string;
}

export type StreamEvent =
  | StreamCreatedEvent
  | StreamUpdatedEvent
  | StreamCancelledEvent;

/**
 * Event ingestion result
 */
export interface EventIngestionResult {
  eventId: string;
  streamId: string;
  action: "created" | "updated" | "ignored";
  success: boolean;
  error?: string;
}

/**
 * Stream Event Service
 *
 * Processes blockchain events with idempotency guarantees:
 * - Each event is identified by transaction_hash + event_index
 * - Duplicate events are safely ignored
 * - Out-of-order events are handled via upsert logic
 */
export const streamEventService = {
  /**
   * Process a stream created event
   *
   * @param event The blockchain event
   * @param correlationId Request ID for tracing
   */
  processStreamCreated(
    event: StreamCreatedEvent,
    correlationId?: string,
  ): EventIngestionResult {
    const eventId = `${event.transactionHash}-${event.eventIndex}`;

    info("Processing StreamCreated event", {
      eventId,
      contractId: event.contractId,
      correlationId,
    });

    try {
      // Generate deterministic stream ID from chain data
      const streamId = generateStreamId(
        event.transactionHash,
        event.eventIndex,
      );

      // Transform event to database input
      const input: CreateStreamInput = {
        id: streamId,
        sender_address: event.sender,
        recipient_address: event.recipient,
        amount: event.amount,
        streamed_amount: "0",
        remaining_amount: event.amount,
        rate_per_second: event.ratePerSecond,
        start_time: event.startTime,
        end_time: event.endTime,
        contract_id: event.contractId,
        transaction_hash: event.transactionHash,
        event_index: event.eventIndex,
      };

      // Upsert with idempotency
      const result = streamRepository.upsertStream(input, correlationId);

      if (result.created) {
        info("Stream created from event", { streamId, eventId, correlationId });
        const hub = getStreamHub();
        if (hub) {
          hub.broadcast({ 
            streamId, 
            eventId, 
            payload: { ...input, event: 'stream.created' } 
          }).catch(err => {
            logError("Failed to broadcast stream created event", { streamId, eventId, error: err.message });
          });
        }
        return { eventId, streamId, action: "created", success: true };
      } else if (result.updated) {
        info("Stream updated from event", { streamId, eventId, correlationId });
        const hub = getStreamHub();
        if (hub) {
          hub.broadcast({ 
            streamId, 
            eventId, 
            payload: { ...input, event: 'stream.updated' } 
          }).catch(err => {
            logError("Failed to broadcast stream updated event", { streamId, eventId, error: err.message });
          });
        }
        return { eventId, streamId, action: "updated", success: true };
      } else {
        debug("Stream already exists (idempotent)", {
          streamId,
          eventId,
          correlationId,
        });
        return { eventId, streamId, action: "ignored", success: true };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logError("Failed to process StreamCreated event", {
        eventId,
        error: message,
        correlationId,
      });
      return {
        eventId,
        streamId: "",
        action: "created",
        success: false,
        error: message,
      };
    }
  },

  /**
   * Process a stream updated event
   *
   * @param event The blockchain event
   * @param correlationId Request ID for tracing
   */
  processStreamUpdated(
    event: StreamUpdatedEvent,
    correlationId?: string,
  ): EventIngestionResult {
    const eventId = `${event.transactionHash}-${event.eventIndex}`;

    info("Processing StreamUpdated event", {
      eventId,
      streamId: event.streamId,
      correlationId,
    });

    try {
      // Get current stream state
      const existing = streamRepository.getById(event.streamId);

      if (!existing) {
        warn("Stream not found for update", {
          streamId: event.streamId,
          eventId,
        });
        return {
          eventId,
          streamId: event.streamId,
          action: "updated",
          success: false,
          error: `Stream not found: ${event.streamId}`,
        };
      }

      // Update stream with new values
      const update = {
        ...(event.status && { status: event.status }),
        ...(event.streamedAmount && {
          streamed_amount: event.streamedAmount,
        }),
        ...(event.remainingAmount && {
          remaining_amount: event.remainingAmount,
        }),
        ...(event.endTime && { end_time: event.endTime }),
      };

      if (Object.keys(update).length > 0) {
        streamRepository.updateStream(event.streamId, update, correlationId);
        info("Stream updated from event", {
          streamId: event.streamId,
          eventId,
          correlationId,
        });
        const hub = getStreamHub();
        if (hub) {
          hub.broadcast({ 
            streamId: event.streamId, 
            eventId, 
            payload: { ...update, event: 'stream.updated' } 
          }).catch(err => {
            logError("Failed to broadcast stream updated event", { streamId: event.streamId, eventId, error: err.message });
          });
        }
        return {
          eventId,
          streamId: event.streamId,
          action: "updated",
          success: true,
        };
      }

      return {
        eventId,
        streamId: event.streamId,
        action: "ignored",
        success: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logError("Failed to process StreamUpdated event", {
        eventId,
        error: message,
        correlationId,
      });
      return {
        eventId,
        streamId: event.streamId,
        action: "updated",
        success: false,
        error: message,
      };
    }
  },

  /**
   * Process a stream cancelled event
   *
   * @param event The blockchain event
   * @param correlationId Request ID for tracing
   */
  processStreamCancelled(
    event: StreamCancelledEvent,
    correlationId?: string,
  ): EventIngestionResult {
    const eventId = `${event.transactionHash}-${event.eventIndex}`;

    info("Processing StreamCancelled event", {
      eventId,
      streamId: event.streamId,
      correlationId,
    });

    try {
      streamRepository.updateStream(
        event.streamId,
        { status: "cancelled" },
        correlationId,
      );
      info("Stream cancelled from event", {
        streamId: event.streamId,
        eventId,
        correlationId,
      });
      const hub = getStreamHub();
      if (hub) {
        hub.broadcast({ 
          streamId: event.streamId, 
          eventId, 
          payload: { status: 'cancelled', event: 'stream.cancelled' } 
        }).catch(err => {
          logError("Failed to broadcast stream cancelled event", { streamId: event.streamId, eventId, error: err.message });
        });
      }
      return {
        eventId,
        streamId: event.streamId,
        action: "updated",
        success: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logError("Failed to process StreamCancelled event", {
        eventId,
        error: message,
        correlationId,
      });
      return {
        eventId,
        streamId: event.streamId,
        action: "updated",
        success: false,
        error: message,
      };
    }
  },

  /**
   * Process any stream event (dispatches to appropriate handler)
   *
   * @param event The blockchain event
   * @param correlationId Request ID for tracing
   */
  processEvent(
    event: StreamEvent,
    correlationId?: string,
  ): EventIngestionResult {
    switch (event.type) {
      case "StreamCreated":
        return this.processStreamCreated(event, correlationId);
      case "StreamUpdated":
        return this.processStreamUpdated(event, correlationId);
      case "StreamCancelled":
        return this.processStreamCancelled(event, correlationId);
      default:
        const exhaustiveCheck: never = event;
        return {
          eventId: "",
          streamId: "",
          action: "created",
          success: false,
          error: `Unknown event type: ${exhaustiveCheck}`,
        };
    }
  },

  /**
   * Batch process multiple events
   *
   * @param events Array of events to process
   * @param correlationId Request ID for tracing
   */
  processBatch(
    events: StreamEvent[],
    correlationId?: string,
  ): EventIngestionResult[] {
    info("Processing event batch", { count: events.length, correlationId });

    const results: EventIngestionResult[] = [];

    for (const event of events) {
      results.push(this.processEvent(event, correlationId));
    }

    const successCount = results.filter((r) => r.success).length;
    info("Batch processed", {
      total: events.length,
      successful: successCount,
      failed: events.length - successCount,
      correlationId,
    });

    return results;
  },
};

/**
 * Generate a deterministic stream ID from transaction hash and event index
 *
 * Format: stream-{txHash}-{eventIndex}
 * This ensures the same event always produces the same ID
 */
function generateStreamId(transactionHash: string, eventIndex: number): string {
  return `stream-${transactionHash}-${eventIndex}`;
}
