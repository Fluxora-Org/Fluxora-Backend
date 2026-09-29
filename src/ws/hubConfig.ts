/**
 * WebSocket hub configuration.
 *
 * Every tunable the hub uses is declared in the validated environment schema
 * (`src/config/env-schema/`). This module is the only place that turns those
 * validated settings plus the per-instance `StreamHubOptions` overrides into
 * the concrete values the hub, its registry, and its backpressure layer run
 * with — no module below reads `process.env` on its own.
 *
 * @module ws/hubConfig
 */

import { z } from 'zod';
import { getConfig, initializeConfig } from '../config/env.js';
import type { Config } from '../config/env.js';
import {
  DEFAULT_WS_BATCH_FLUSH_MS,
  DEFAULT_WS_BATCH_MAX_SIZE,
  WS_BATCH_FLUSH_MS_MAX,
  WS_BATCH_FLUSH_MS_MIN,
  WS_BATCH_MAX_SIZE_MAX,
  WS_BATCH_MAX_SIZE_MIN,
  wsBatchingEnvSchema,
} from '../config/env-schema/server.js';
import { StreamHubOptions } from './hubTypes.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Ceiling for a single serialized outbound frame, in bytes. */
export const MAX_MESSAGE_BYTES = 4_096;
/** Inbound messages a single connection may send per rate-limit window. */
export const RATE_LIMIT_MAX = 30;
/** Sliding window used by the per-connection inbound rate limit, in ms. */
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const DEFAULT_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;
export const DEFAULT_WS_MAX_OUTBOUND_QUEUE_PER_CONNECTION = 128;
export const DEFAULT_WS_MAX_OUTBOUND_QUEUE_BYTES_PER_CONNECTION = 1024 * 1024;

export const BACKPRESSURE_DROP_BYTES = 1 * 1024 * 1024;
export const BACKPRESSURE_TERMINATE_BYTES = 4 * 1024 * 1024;
/** Fanout is yielded to the event loop after this many recipients. */
export const FANOUT_YIELD_BATCH = 256;

/** Graceful-close default, and the floor applied to an explicit override. */
export const DEFAULT_CLOSE_FRAME_TIMEOUT_MS = 5_000;
export const MIN_CLOSE_FRAME_TIMEOUT_MS = 50;

/** Heartbeat cadence applied when no override is supplied. */
export const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30_000;
/** Consecutive missed pongs tolerated before a connection is terminated. */
export const DEFAULT_HEALTH_PROBE_MAX_MISSED = 2;

/**
 * WebSocket close reason strings sent in the close-frame payload during a
 * graceful shutdown.  These mirror the SSE_CLOSE_REASONS from
 * `src/streams/sseEmitter.ts` so that both transport layers speak the same
 * reason vocabulary.
 *
 * Clients that receive a close frame with code 1001 should inspect the
 * JSON-encoded `reason` field to decide whether to reconnect immediately
 * (e.g. `max_duration`) or back off (e.g. `server_shutdown`).
 *
 * @example
 * // Client-side (browser)
 * ws.onclose = (event) => {
 *   const { reason } = JSON.parse(event.reason);
 *   if (reason === WS_CLOSE_REASONS.SERVER_SHUTDOWN) {
 *     scheduleReconnectWithBackoff();
 *   }
 * };
 *
 * @security The payload carries only the reason enum string — no stream data,
 *   user information, or internal diagnostics are included.
 */
export const WS_CLOSE_REASONS = {
  /**
   * The server is shutting down gracefully (e.g. SIGTERM/SIGINT).
   * Clients should stop reconnecting until the service comes back up,
   * typically using exponential backoff with jitter.
   */
  SERVER_SHUTDOWN: 'server_shutdown',
  /**
   * The connection exceeded its configured maximum duration.
   * Clients may reconnect immediately.
   */
  MAX_DURATION: 'max_duration',
} as const;

/** Union of all documented WebSocket close reason strings. */
export type WsCloseReason = (typeof WS_CLOSE_REASONS)[keyof typeof WS_CLOSE_REASONS];

/**
 * The RFC 6455 close code used when the server initiates a graceful shutdown.
 *
 * 1001 "Going Away" — the server or client is "going away", e.g. a server
 * is going down or a browser has navigated away from a page.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
 */
export const WS_CLOSE_CODE_GOING_AWAY = 1001;

/** Clamp a batching tunable to the range the schema validates against. */
export function clampBatchFlushMs(value: number): number {
  return Math.max(WS_BATCH_FLUSH_MS_MIN, Math.min(WS_BATCH_FLUSH_MS_MAX, value));
}

export function clampBatchMaxSize(value: number): number {
  return Math.max(WS_BATCH_MAX_SIZE_MIN, Math.min(WS_BATCH_MAX_SIZE_MAX, value));
}

/**
 * Module-level batching defaults, resolved through the same schema fragment
 * the composed environment schema uses.
 *
 * The hub reads its own effective values from {@link resolveHubConfig} at
 * construction time; these constants are the process-wide defaults exported
 * for diagnostics and for suites that assert the schema's clamping behaviour.
 * The schema guarantees a value in range, so a rejected environment simply
 * falls back to the declared defaults rather than failing the import.
 */
function readBatchingDefaults(): { flushMs: number; maxSize: number } {
  const parsed = z.object(wsBatchingEnvSchema).safeParse(process.env);
  if (!parsed.success) {
    return { flushMs: DEFAULT_WS_BATCH_FLUSH_MS, maxSize: DEFAULT_WS_BATCH_MAX_SIZE };
  }
  return { flushMs: parsed.data.WS_BATCH_FLUSH_MS, maxSize: parsed.data.WS_BATCH_MAX_SIZE };
}

const batchingDefaults = readBatchingDefaults();

/**
 * Flush window in milliseconds. After the first event enters a client's batch
 * accumulator, a timer fires after this many milliseconds and flushes all
 * queued events as a single `stream_update_batch` frame.
 *
 * Configured by `WS_BATCH_FLUSH_MS` (clamped to 5–5 000 ms). Default: 50 ms.
 */
export const WS_BATCH_FLUSH_MS: number = batchingDefaults.flushMs;

/**
 * Maximum number of events per batch before triggering an early (pre-window)
 * flush. Keeps individual frames well below MAX_MESSAGE_BYTES even when a
 * stream emits a very high burst.
 *
 * Configured by `WS_BATCH_MAX_SIZE` (clamped to 1–500). Default: 25.
 */
export const WS_BATCH_MAX_SIZE: number = batchingDefaults.maxSize;

/** The validated settings one hub instance runs with. */
export interface HubConfig {
  wsAuthRequired: boolean;
  jwtSecret: string | undefined;
  allowedOrigins: ReadonlySet<string> | undefined;
  maxSubscriptionsPerConnection: number;
  maxOutboundQueuePerConnection: number;
  maxOutboundQueueBytesPerConnection: number;
  maxInboundMessageBytes: number;
  batchFlushMs: number;
  batchMaxSize: number;
  closeFrameTimeoutMs: number;
  healthProbeIntervalMs: number;
  healthProbeMaxMissed: number;
  healthProbeStallBytes: number;
  dropBytes: number;
  terminateBytes: number;
}

/**
 * Read the validated runtime configuration, initializing it on first use.
 *
 * The hub can be constructed before the startup sequence has initialized the
 * config singleton (e.g. by a test that imports the module directly), so the
 * uninitialized case is treated as "initialize now" exactly as before.
 */
export function loadRuntimeConfig(): Config {
  try {
    return getConfig();
  } catch {
    return initializeConfig();
  }
}

function toOriginSet(origins: string[] | undefined): ReadonlySet<string> | undefined {
  if (!origins || origins.length === 0) return undefined;
  const filtered = origins.filter((origin) => origin.length > 0);
  return filtered.length > 0 ? new Set(filtered) : undefined;
}

/**
 * Merge per-instance options over the validated environment configuration.
 *
 * Options win so tests can construct a hub with different limits without
 * mutating env vars; everything else comes from the schema, so a hub can no
 * longer disagree with `docs/env-reference.md` about a default.
 */
export function resolveHubConfig(options?: StreamHubOptions): HubConfig {
  const runtimeConfig = loadRuntimeConfig();

  const configuredOrigins = options?.allowedOrigins ?? runtimeConfig.wsAllowedOrigins;

  return {
    wsAuthRequired: options?.wsAuthRequired ?? runtimeConfig.wsAuthRequired,
    jwtSecret: options?.jwtSecret ?? runtimeConfig.jwtSecret,
    allowedOrigins: toOriginSet(configuredOrigins),
    maxSubscriptionsPerConnection:
      options?.maxSubscriptionsPerConnection ??
      runtimeConfig.wsMaxSubscriptionsPerConnection ??
      DEFAULT_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
    maxOutboundQueuePerConnection:
      options?.maxOutboundQueuePerConnection ??
      runtimeConfig.wsMaxOutboundQueuePerConnection ??
      DEFAULT_WS_MAX_OUTBOUND_QUEUE_PER_CONNECTION,
    maxOutboundQueueBytesPerConnection:
      options?.maxOutboundQueueBytesPerConnection ??
      runtimeConfig.wsMaxOutboundQueueBytesPerConnection ??
      DEFAULT_WS_MAX_OUTBOUND_QUEUE_BYTES_PER_CONNECTION,
    maxInboundMessageBytes:
      options?.maxInboundMessageBytes ?? runtimeConfig.wsMaxInboundMessageBytes,
    batchFlushMs:
      options?.batching?.flushMs !== undefined
        ? clampBatchFlushMs(options.batching.flushMs)
        : WS_BATCH_FLUSH_MS,
    batchMaxSize:
      options?.batching?.maxSize !== undefined
        ? clampBatchMaxSize(options.batching.maxSize)
        : WS_BATCH_MAX_SIZE,
    // Clamped to a minimum of 50 ms to avoid degenerate zero-timeout values
    // in production misconfiguration.
    closeFrameTimeoutMs:
      typeof options?.closeFrameTimeoutMs === 'number' && options.closeFrameTimeoutMs > 0
        ? Math.max(MIN_CLOSE_FRAME_TIMEOUT_MS, options.closeFrameTimeoutMs)
        : DEFAULT_CLOSE_FRAME_TIMEOUT_MS,
    healthProbeIntervalMs: options?.healthProbeIntervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS,
    healthProbeMaxMissed: options?.healthProbeMaxMissed ?? DEFAULT_HEALTH_PROBE_MAX_MISSED,
    healthProbeStallBytes:
      typeof options?.healthProbeStallBytes === 'number' && options.healthProbeStallBytes >= 0
        ? options.healthProbeStallBytes
        : BACKPRESSURE_DROP_BYTES,
    dropBytes:
      typeof options?.dropBytes === 'number' && options.dropBytes >= 0
        ? options.dropBytes
        : BACKPRESSURE_DROP_BYTES,
    terminateBytes:
      typeof options?.terminateBytes === 'number' && options.terminateBytes >= 0
        ? options.terminateBytes
        : BACKPRESSURE_TERMINATE_BYTES,
  };
}
