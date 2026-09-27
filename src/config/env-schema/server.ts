/**
 * API server runtime environment variables (feature flags, auth toggles,
 * WebSocket/SSE limits, health checks, gRPC services).
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect.
 */
import { booleanEnv, integerEnv, optionalString } from './parsers.js';

/**
 * Default ceiling on a single inbound WebSocket frame, in bytes.
 *
 * Exported so the WebSocket message handler can size its parser without
 * reaching into the parsed config (which is only available after startup).
 */
export const DEFAULT_WS_MAX_INBOUND_MESSAGE_BYTES = 4_096;

export const serverEnvSchema = {
  /** Validate stream queries against allowlisted columns. @default true */
  ENABLE_STREAM_VALIDATION: booleanEnv().default(true),
  /** Global rate-limiting switch; defaults to off in production when unset. */
  ENABLE_RATE_LIMIT: booleanEnv().optional(),
  /** Require the partner API token on partner endpoints. @default false */
  REQUIRE_PARTNER_AUTH: booleanEnv().default(false),
  /** Bearer token partner clients must present when REQUIRE_PARTNER_AUTH is on. */
  PARTNER_API_TOKEN: optionalString('PARTNER_API_TOKEN'),
  /** Require the admin API token on admin endpoints. @default false */
  REQUIRE_ADMIN_AUTH: booleanEnv().default(false),
  /** Bearer token admins must present when REQUIRE_ADMIN_AUTH is on. */
  ADMIN_API_TOKEN: optionalString('ADMIN_API_TOKEN'),

  /** Require Origin allowlist checks on WebSocket upgrades. @default false */
  WS_AUTH_REQUIRED: booleanEnv().default(false),
  /** Comma-separated allowed origins for WebSocket connections. */
  WS_ALLOWED_ORIGINS: optionalString('WS_ALLOWED_ORIGINS'),
  /** Max concurrent WebSocket connections per client IP. @default 10 */
  WS_MAX_CONNECTIONS_PER_IP: integerEnv('WS_MAX_CONNECTIONS_PER_IP', 1, 100_000).default(10),
  /** Max subscription filters a single WebSocket connection may hold. @default 32 */
  WS_MAX_SUBSCRIPTIONS_PER_CONNECTION: integerEnv(
    'WS_MAX_SUBSCRIPTIONS_PER_CONNECTION',
    1,
    100_000,
  ).default(32),
  /** Max messages queued for a slow WebSocket client before backpressure. @default 128 */
  WS_MAX_OUTBOUND_QUEUE_PER_CONNECTION: integerEnv(
    'WS_MAX_OUTBOUND_QUEUE_PER_CONNECTION',
    1,
    100_000,
  ).default(128),
  /** Max bytes queued for a slow WebSocket client. @default 1048576 */
  WS_MAX_OUTBOUND_QUEUE_BYTES_PER_CONNECTION: integerEnv(
    'WS_MAX_OUTBOUND_QUEUE_BYTES_PER_CONNECTION',
    1,
    64 * 1024 * 1024,
  ).default(1024 * 1024),
  /** Max size of a single inbound WebSocket frame, in bytes. @default 4096 */
  WS_MAX_INBOUND_MESSAGE_BYTES: integerEnv(
    'WS_MAX_INBOUND_MESSAGE_BYTES',
    1,
    16 * 1024 * 1024,
  ).default(DEFAULT_WS_MAX_INBOUND_MESSAGE_BYTES),
  /** Max WebSocket reconnect attempts per client window. @default 20 */
  WS_RECONNECT_LIMIT: integerEnv('WS_RECONNECT_LIMIT', 1, 100_000).default(20),
  /** Sliding window for WS reconnect limiting, in ms. @default 60000 */
  WS_RECONNECT_WINDOW_MS: integerEnv('WS_RECONNECT_WINDOW_MS', 1, 86_400_000).default(60_000),

  /** SSE connections allowed per client IP. @default 10 */
  SSE_MAX_CONNECTIONS_PER_IP: integerEnv('SSE_MAX_CONNECTIONS_PER_IP', 1, 100_000).default(10),
  /** SSE connections allowed per API key. @default 50 */
  SSE_MAX_CONNECTIONS_PER_API_KEY: integerEnv(
    'SSE_MAX_CONNECTIONS_PER_API_KEY',
    1,
    100_000
  ).default(50),
  /** SSE connections allowed process-wide. @default 1000 */
  SSE_MAX_GLOBAL_CONNECTIONS: integerEnv('SSE_MAX_GLOBAL_CONNECTIONS', 1, 100_000).default(1000),
  /** Max lifetime of one SSE connection in ms. @default 1800000 (30 min) */
  SSE_MAX_CONNECTION_DURATION_MS: integerEnv(
    'SSE_MAX_CONNECTION_DURATION_MS',
    1,
    86_400_000
  ).default(30 * 60 * 1000),
  /** Seconds advertised to SSE clients after a 429 via Retry-After. @default 15 */
  SSE_RETRY_AFTER_SECONDS: integerEnv('SSE_RETRY_AFTER_SECONDS', 1, 86_400).default(15),
  /** Milliseconds the browser EventSource waits before reconnecting (sent as SSE retry: directive). @default 5000 */
  SSE_RETRY_MS: integerEnv('SSE_RETRY_MS', 100, 300_000).default(5000),
  /** Interval in milliseconds between SSE heartbeat comments per connection. @default 30000 */
  SSE_HEARTBEAT_INTERVAL_MS: integerEnv('SSE_HEARTBEAT_INTERVAL_MS', 100, 300_000).default(
    30_000
  ),
  /** Milliseconds to wait for each SSE connection to drain during shutdown before force-closing. @default 30000 */
  SSE_DRAIN_TIMEOUT_MS: integerEnv('SSE_DRAIN_TIMEOUT_MS', 1_000, 60_000).default(30_000),

  /** Run the chain-indexing loop inside this process. @default false */
  INDEXER_ENABLED: booleanEnv().default(false),
  /** Run background queue workers inside this process. @default false */
  WORKER_ENABLED: booleanEnv().default(false),

  /** Per-checker timeout for HealthCheckManager. Must be strictly greater than 0. @default 5000 */
  HEALTH_CHECK_TIMEOUT_MS: integerEnv('HEALTH_CHECK_TIMEOUT_MS', 1).default(5000),
  /** Interval between background health-check runs. Must be strictly greater than 0. @default 30000 */
  HEALTH_CHECK_INTERVAL_MS: integerEnv('HEALTH_CHECK_INTERVAL_MS', 1).default(30000),

  /** Enables the grpc.health.v1.Health service for Kubernetes-native gRPC probes. @default false */
  GRPC_HEALTH_ENABLED: booleanEnv().default(false),
  /** Port the gRPC health service binds to when enabled. Separate from PORT (HTTP). @default 50051 */
  GRPC_HEALTH_PORT: integerEnv('GRPC_HEALTH_PORT', 1, 65535).default(50051),
  /** Enables the optional gRPC transcoding gateway for indexer communication. Default off. @default false */
  GRPC_GATEWAY_ENABLED: booleanEnv().default(false),
  /** Port the gRPC indexer gateway binds to when enabled. @default 50052 */
  GRPC_GATEWAY_PORT: integerEnv('GRPC_GATEWAY_PORT', 1, 65535).default(50052),
};
