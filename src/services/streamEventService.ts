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
import { enrichActiveSpanWithStream, traceSpan } from "../tracing/hooks.js";
import { deriveStreamId } from "../streams/sseEmitter.js";

/**
 * Structured event code emitted in all catch-block log entries.
 *
 * Using a single, stable string allows log-based alerting rules to
 * filter on `event === STREAM_EVENT_PROCESSING_FAILED` and then
 * further narrow by `eventType` to target a specific handler.
 *
 * @example
 * // CloudWatch / Datadog filter:
 * //   { event: "stream_event_processing_failed", eventType: "StreamCancelled" }
 */
export const STREAM_EVENT_PROCESSING_FAILED = "stream_event_processing_failed" as const;


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
  async processStreamCreated(
    event: StreamCreatedEvent,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const eventId = `${event.transactionHash}-${event.eventIndex}`;

    info("Processing StreamCreated event", {
      eventId,
      contractId: event.contractId,
      correlationId,
    });

    try {
      // Generate deterministic stream ID from chain data
      const streamId = deriveStreamId(
        event.transactionHash,
        event.eventIndex,
      );

      enrichActiveSpanWithStream(streamId, event.sender, event.recipient);

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
      const result = await streamRepository.upsertStream(input, correlationId);

      if (result.created) {
        info("Stream created from event", { streamId, eventId, correlationId });
        const hub = getStreamHub();
        if (hub) {
          hub.broadcast({
            streamId,
            eventId,
            recipientAddress: input.recipient_address,
            payload: { ...input, event: 'stream.created' },
          }).catch((err: Error) => {
            logError("Failed to broadcast stream created event", { streamId, eventId, error: err.message });
          });
        }
        return { eventId, streamId, action: "created", success: true };
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
      /**
       * Structured catch block for StreamCreated processing failures.
       *
       * Fields:
       *   event     - stable code for log-based alerting
       *   eventType - discriminates which handler failed
       *   contractId - chain contract that emitted the event
       *
       * NOTE: streamId is intentionally omitted here because it may not
       * have been derived yet when the error occurred. sender/recipient
       * Stellar addresses are NOT logged (classified as PII in src/pii/policy.ts).
       */
      logError("Failed to process StreamCreated event", {
        event: STREAM_EVENT_PROCESSING_FAILED,
        eventType: event.type,
        contractId: event.contractId,
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
  async processStreamUpdated(
    event: StreamUpdatedEvent,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const eventId = `${event.transactionHash}-${event.eventIndex}`;

    info("Processing StreamUpdated event", {
      eventId,
      streamId: event.streamId,
      correlationId,
    });

    try {
      enrichActiveSpanWithStream(event.streamId);
      // Get current stream state
      const existing = await streamRepository.getById(event.streamId);

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

      enrichActiveSpanWithStream(event.streamId, existing.sender_address, existing.recipient_address);

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
        const updatedStream = await streamRepository.updateStream(event.streamId, update, correlationId);
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
            recipientAddress: updatedStream.recipient_address,
            payload: { ...update, event: 'stream.updated' },
          }).catch((err: Error) => {
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
      /**
       * Structured catch block for StreamUpdated processing failures.
       *
       * Fields:
       *   event      - stable code for log-based alerting
       *   eventType  - discriminates which handler failed
       *   contractId - chain contract that emitted the event
       *   streamId   - identifies the affected stream
       *
       * NOTE: sender/recipient Stellar addresses are NOT logged
       * (classified as PII in src/pii/policy.ts).
       */
      logError("Failed to process StreamUpdated event", {
        event: STREAM_EVENT_PROCESSING_FAILED,
        eventType: event.type,
        contractId: event.contractId,
        streamId: event.streamId,
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
  async processStreamCancelled(
    event: StreamCancelledEvent,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const eventId = `${event.transactionHash}-${event.eventIndex}`;

    info("Processing StreamCancelled event", {
      eventId,
      streamId: event.streamId,
      correlationId,
    });

    try {
      // Enrich span with stream ID first (streamId is always available)
      enrichActiveSpanWithStream(event.streamId);

      // Fetch existing stream to enrich span with sender/recipient before update.
      // Security: sender_address and recipient_address are PII — they are passed
      // only to enrichActiveSpanWithStream which guards against logging raw values.
      const existing = await streamRepository.getById(event.streamId);
      if (existing) {
        enrichActiveSpanWithStream(
          event.streamId,
          existing.sender_address,
          existing.recipient_address,
        );
      }

      const updatedStream = await streamRepository.updateStream(
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
          recipientAddress: updatedStream.recipient_address,
          payload: { status: 'cancelled', event: 'stream.cancelled' },
        }).catch((err: Error) => {
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
      /**
       * Structured catch block for StreamCancelled processing failures.
       *
       * Fields:
       *   event      - stable code for log-based alerting
       *   eventType  - discriminates which handler failed
       *   contractId - chain contract that emitted the event
       *   streamId   - identifies the affected stream
       *
       * NOTE: sender/recipient Stellar addresses are NOT logged
       * (classified as PII in src/pii/policy.ts).
       */
      logError("Failed to process StreamCancelled event", {
        event: STREAM_EVENT_PROCESSING_FAILED,
        eventType: event.type,
        contractId: event.contractId,
        streamId: event.streamId,
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
   * Process any stream event (dispatches to appropriate handler).
   *
   * Creates a parent tracing span that groups all three event-type branches
   * (StreamCreated, StreamUpdated, StreamCancelled) under a single trace.
   * The span carries `stream.event_type` and, when provided, `correlation_id`
   * as attributes.
   *
   * Security: Stellar address values (sender_address, recipient_address) must
   * NOT be set as span attributes here — see src/pii/policy.ts.
   *
   * @param event The blockchain event
   * @param correlationId Request ID for tracing
   */
  async processEvent(
    event: StreamEvent,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const spanCorrelationId = correlationId ?? "unknown";
    const spanTags: Record<string, unknown> = {
      "stream.event_type": event.type,
    };
    if (correlationId !== undefined) {
      spanTags["correlation_id"] = correlationId;
    }

    return traceSpan(
      "streamEventService.processEvent",
      spanCorrelationId,
      spanTags,
      async () => {
        switch (event.type) {
          case "StreamCreated":
            return this.processStreamCreated(event, correlationId);
          case "StreamUpdated":
            return this.processStreamUpdated(event, correlationId);
          case "StreamCancelled":
            return this.processStreamCancelled(event, correlationId);
          default: {
            const exhaustiveCheck: never = event;
            return {
              eventId: "",
              streamId: "",
              action: "created" as const,
              success: false,
              error: `Unknown event type: ${exhaustiveCheck as string}`,
            };
          }
        }
      },
    );
  },

  /**
   * Batch process multiple events
   *
   * @param events Array of events to process
   * @param correlationId Request ID for tracing
   */
  async processBatch(
    events: StreamEvent[],
    correlationId?: string,
  ): Promise<EventIngestionResult[]> {
    info("Processing event batch", { count: events.length, correlationId });

    const results: EventIngestionResult[] = [];

    for (const event of events) {
      results.push(await this.processEvent(event, correlationId));
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



