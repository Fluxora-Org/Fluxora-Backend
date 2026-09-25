<!-- GENERATED FILE — do not edit by hand. Run `pnpm tsx scripts/generate-env-reference.ts` to regenerate. -->

# Environment Variable Reference

Generated from the composed environment schema (`src/config/env-schema/schema.ts`,
issue #1519). 152 variables across 11 subsystems.

“—” in the Default column means the variable has no schema-level default
(required, or optional with a runtime fallback).

## Core

| Variable | Purpose | Default |
|---|---|---|
| `FLUXORA_SHUTDOWN` | Master shutdown switch: when truthy the process drains and exits. Used by orchestrators to quiesce the service. @default unset (service keeps running) | — |
| `NODE_ENV` | Runtime deployment target. Drives production-only invariants (debug-log ban, wildcard-CORS ban, PGCRYPTO_KEY requirement) and the default Stellar network. @default 'development' | `development` |
| `PORT` | HTTP listen port for the Express server. Range 1–65535. @default 3000 | `3000` |

## Database

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_REPLICA_URL` | Optional read-replica connection string. When set, SELECT queries on streams are routed through a dedicated replica pool. @default unset (all queries use the primary pool) | — |
| `DATABASE_URL` | Primary PostgreSQL connection string. Required — no default. | — |
| `DB_CONNECTION_TIMEOUT` | New connection acquisition timeout in ms. @default 5000 | `5000` |
| `DB_IDLE_TIMEOUT` | Idle client release timeout in ms. @default 30000 | `30000` |
| `DB_POOL_MAX` | Maximum primary-pool connections. @default 10 | `10` |
| `DB_POOL_MIN` | Minimum primary-pool connections. @default 2 | `2` |
| `POOL_QUEUE_LIMIT` | Max requests allowed to queue on the primary pool before fast-failing with 503. @default 50 | `50` |
| `REPLICA_QUEUE_LIMIT` | Max requests allowed to queue on the replica pool before fast-failing. @default 25 | `25` |
| `REPLICA_STATEMENT_TIMEOUT_MS` | Replica statement timeout in ms. Defaults to STATEMENT_TIMEOUT_MS when absent. 0 = disabled. | — |
| `SLOW_QUERY_THRESHOLD_MS` | Queries slower than this are logged as slow. @default 1000 | `1000` |
| `STATEMENT_TIMEOUT_MS` | statement_timeout for primary connections in ms; 0 disables. @default 5000 | `5000` |

## Redis

| Variable | Purpose | Default |
|---|---|---|
| `REDIS_CLUSTER_NODES` | Comma-separated list of cluster nodes: host:port,host:port | — |
| `REDIS_CONNECT_TIMEOUT_MS` | TCP connect timeout for each Redis client, in ms. @default 5000 | `5000` |
| `REDIS_ENABLED` | Master switch for Redis-backed features; false falls back to in-memory. @default true | `true` |
| `REDIS_MAX_RETRIES_PER_REQUEST` | Command retries per request before a Redis call fails. @default 3 | `3` |
| `REDIS_MODE` | Client topology: `standalone` (single endpoint), `sentinel` (HA via monitors), or `cluster` (sharded). @default 'standalone' | `standalone` |
| `REDIS_RETRY_BASE_DELAY_MS` | Base delay of the Redis reconnect backoff, in ms. @default 50 | `50` |
| `REDIS_RETRY_MAX_ATTEMPTS` | Reconnect attempts before ioredis stops retrying. @default 10 | `10` |
| `REDIS_RETRY_MAX_DELAY_MS` | Ceiling of the Redis reconnect backoff, in ms. @default 2000 | `2000` |
| `REDIS_SENTINEL_HOSTS` | Comma-separated list of sentinel nodes: host:port,host:port | — |
| `REDIS_SENTINEL_NAME` | Sentinel master name (required when REDIS_MODE=sentinel) | — |
| `REDIS_URL` | Redis connection string for cache, pub/sub, and queue backends. @default 'redis://localhost:6379' | `redis://localhost:6379` |

## Stellar

| Variable | Purpose | Default |
|---|---|---|
| `CONTRACT_ADDRESS_STREAMING` | Optional dedicated streaming contract address. Falls back to STELLAR_CONTRACT_ADDRESS when unset. Must be a valid StrKey and is checked against the pinned allowlist when a network is resolved. | — |
| `HORIZON_NETWORK_PASSPHRASE` | Horizon network passphrase; must match the resolved network's passphrase when set. | — |
| `HORIZON_URL` | Horizon API base URL. When unset, falls back to the network default (STELLAR_NETWORKS[network].horizonUrl). | — |
| `STELLAR_CONTRACT_ADDRESS` | Streaming contract address (Stellar contract StrKey, allowlisted when not local). | — |
| `STELLAR_NETWORK` | Target Stellar network. Defaults to `mainnet` when NODE_ENV=production, otherwise `testnet`. `local` skips pinned-address checks for development. | — |
| `STELLAR_RPC_MAX_RETRIES` | Retries per failed RPC call. @default 3 | `3` |
| `STELLAR_RPC_OPERATION_DEADLINES` | Per-operation timeout overrides for Stellar RPC calls. Format: JSON object mapping operation names to timeouts in ms. Example: '{"getLatestLedger":2000,"accountExists":8000}' | — |
| `STELLAR_RPC_RETRY_DELAY` | Base delay between RPC retries in ms. @default 1000 | `1000` |
| `STELLAR_RPC_TIMEOUT` | Per-call RPC timeout in ms. @default 10000 | `10000` |
| `STELLAR_RPC_URL` | Soroban RPC endpoint. @default 'https://soroban-testnet.stellar.org' | `https://soroban-testnet.stellar.org` |
| `STELLAR_TOKEN_ADDRESS` | Token contract address (Stellar contract StrKey, allowlisted when not local). | — |

## Auth & Secrets

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_API_KEY` | Bootstrap admin API key for administrative endpoints. @default unset (admin key auth disabled) | — |
| `API_KEY_PEPPER` | Server-side pepper mixed into every API-key hash. Keeping it out of the database means a leaked `api_keys` table cannot be brute-forced offline. Optional so non-API-key deployments still boot; required at runtime by the hashing helpers, which fail closed when it is absent. | — |
| `API_KEY_PEPPER_PREVIOUS` | Previous API-key pepper, accepted while keys are re-hashed during rotation. | — |
| `API_KEYS` | Comma-separated list of valid API keys. When set, API_KEY_PEPPER becomes required (superRefine invariant). | — |
| `INDEXER_WORKER_TOKEN` | Shared token indexer workers use to authenticate to the API. Required, min 32 chars. | — |
| `JWT_EXPIRES_IN` | JWT lifetime string accepted by jsonwebtoken, e.g. '24h'. @default '24h' | `24h` |
| `JWT_SECRET` | Signs JWTs. Required, minimum 32 characters. Values never appear in error messages. | — |
| `JWT_SECRET_PREVIOUS` | Previous signing key, still accepted during key rotation. Min 32 chars. | — |
| `OIDC_AUDIENCE` | Expected `aud` (client_id) claim on OIDC ID tokens. | — |
| `OIDC_ISSUER_URL` | OIDC issuer base URL, e.g. https://accounts.example.com. JWKS is fetched from `${OIDC_ISSUER_URL}/.well-known/jwks.json`. Unset disables OIDC login. */ | — |
| `PGCRYPTO_KEY` | pgcrypto column-encryption key for PII columns. Required in production (minimum 32 characters); optional otherwise. | — |
| `PGCRYPTO_KEY_PREVIOUS` | Previous pgcrypto key, still used to read rows written before rotation. Min 32 chars. | — |

## HTTP

| Variable | Purpose | Default |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | Comma-separated CORS origins; '*' is rejected in production. | — |
| `GRAPHQL_INTROSPECTION_ENABLED` | Allow the GraphQL introspection query. @default true | `true` |
| `GRAPHQL_PERSISTED_QUERY_ALLOWLIST` | Comma-separated SHA-256 allowlist for GraphQL persisted queries. | — |
| `GRAPHQL_PERSISTED_QUERY_HASH_VERIFICATION` | Require APQ hashes to match the allowlist. @default true | `true` |
| `GRAPHQL_UNPERSISTED_QUERY_POLICY` | Policy for non-persisted GraphQL queries: 'allow' or 'reject'. @default 'allow' | `allow` |
| `LOG_LEVEL` | Application log verbosity. Must not be 'debug' in production. @default 'info' | `info` |
| `MAX_JSON_DEPTH` | Maximum JSON nesting depth accepted by the body parser. @default 20 | `20` |
| `MAX_REQUEST_SIZE` | Maximum accepted request body size; parsed from byte sizes like '1mb'. @default 1048576 (1 MiB) | `1048576` |
| `METRICS_ENABLED` | Expose Prometheus metrics at /metrics. @default true | `true` |
| `REQUEST_TIMEOUT_MS` | Per-request timeout in ms. @default 30000 | `30000` |
| `TRACING_ENABLED` | Master switch for distributed tracing. @default false | `false` |
| `TRACING_HEAD_SAMPLE_RATE` | Overrides TRACING_SAMPLE_RATE when the head strategy is active. | — |
| `TRACING_LOG_EVENTS` | Emit log records as OTel log events. @default false | `false` |
| `TRACING_OTEL_ENABLED` | Export traces to an OpenTelemetry collector. @default false | `false` |
| `TRACING_PER_ROUTE_OVERRIDES` | JSON per-route sampling overrides, e.g. '{"/health":0}'. | — |
| `TRACING_SAMPLE_RATE` | Head/tail sampling ratio between 0 and 1. @default 1 | `1` |
| `TRACING_SAMPLING_STRATEGY` | Sampling strategy applied by the tracer. @default 'head' | `head` |
| `TRACING_TAIL_KEEP_ERRORS` | Keep spans carrying error status under tail sampling. @default true | `true` |

## Webhooks

| Variable | Purpose | Default |
|---|---|---|
| `FLUXORA_WEBHOOK_SECRET` | Fluxora-platform inbound webhook HMAC secret. | — |
| `FLUXORA_WEBHOOK_SECRET_PREVIOUS` | Previous Fluxora-platform webhook secret during rotation. | — |
| `WEBHOOK_ALLOWED_HOSTS` | Comma-separated SSRF allowlist of webhook hostnames. | — |
| `WEBHOOK_BATCH_MAX_BACKOFF_MS` | Cap of the exponential backoff between batch retries, in ms. @default 60000 | `60000` |
| `WEBHOOK_BATCH_SIZE` | Webhooks dispatched per outbox poll batch. @default 10 | `10` |
| `WEBHOOK_CIRCUIT_BREAKER_RESET_MS` | Delay before a tripped circuit breaker half-opens, in ms. @default 300000 | `300000` |
| `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD` | Consecutive failures before the circuit breaker opens; 0 disables. @default 0 | `0` |
| `WEBHOOK_DNS_TIMEOUT_MS` | DNS resolution timeout per webhook delivery in ms. @default 2000 | `2000` |
| `WEBHOOK_MAX_RESPONSE_BYTES` | Largest accepted response body per delivery, parsed from byte sizes. @default 65536 (64 KiB) | `65536` |
| `WEBHOOK_POLL_INTERVAL_MS` | Poll interval for the webhook outbox dispatcher in ms. @default 10000 | `10000` |
| `WEBHOOK_RETRY_BURST` | Extra tokens allowed above the steady retry rate in a burst. @default 0 | `0` |
| `WEBHOOK_RETRY_RPS` | Steady-state retry dispatch rate, webhooks/second. @default 10 | `10` |
| `WEBHOOK_SECRET` | HMAC secret signing webhook payloads. | — |
| `WEBHOOK_SECRET_PREVIOUS` | Previous HMAC secret, still verified during rotation. | — |
| `WEBHOOK_URL` | Delivery target for stream event webhooks. @default unset (webhooks disabled) | — |

## Server

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_API_TOKEN` | Bearer token admins must present when REQUIRE_ADMIN_AUTH is on. | — |
| `ENABLE_RATE_LIMIT` | Global rate-limiting switch; defaults to off in production when unset. | — |
| `ENABLE_STREAM_VALIDATION` | Validate stream queries against allowlisted columns. @default true | `true` |
| `GRPC_GATEWAY_ENABLED` | Enables the optional gRPC transcoding gateway for indexer communication. Default off. @default false | `false` |
| `GRPC_GATEWAY_PORT` | Port the gRPC indexer gateway binds to when enabled. @default 50052 | `50052` |
| `GRPC_HEALTH_ENABLED` | Enables the grpc.health.v1.Health service for Kubernetes-native gRPC probes. @default false | `false` |
| `GRPC_HEALTH_PORT` | Port the gRPC health service binds to when enabled. Separate from PORT (HTTP). @default 50051 | `50051` |
| `HEALTH_CHECK_INTERVAL_MS` | Interval between background health-check runs. Must be strictly greater than 0. @default 30000 | `30000` |
| `HEALTH_CHECK_TIMEOUT_MS` | Per-checker timeout for HealthCheckManager. Must be strictly greater than 0. @default 5000 | `5000` |
| `INDEXER_ENABLED` | Run the chain-indexing loop inside this process. @default false | `false` |
| `PARTNER_API_TOKEN` | Bearer token partner clients must present when REQUIRE_PARTNER_AUTH is on. | — |
| `REQUIRE_ADMIN_AUTH` | Require the admin API token on admin endpoints. @default false | `false` |
| `REQUIRE_PARTNER_AUTH` | Require the partner API token on partner endpoints. @default false | `false` |
| `SSE_DRAIN_TIMEOUT_MS` | Milliseconds to wait for each SSE connection to drain during shutdown before force-closing. @default 30000 | `30000` |
| `SSE_HEARTBEAT_INTERVAL_MS` | Interval in milliseconds between SSE heartbeat comments per connection. @default 30000 | `30000` |
| `SSE_MAX_CONNECTION_DURATION_MS` | Max lifetime of one SSE connection in ms. @default 1800000 (30 min) | `1800000` |
| `SSE_MAX_CONNECTIONS_PER_API_KEY` | SSE connections allowed per API key. @default 50 | `50` |
| `SSE_MAX_CONNECTIONS_PER_IP` | SSE connections allowed per client IP. @default 10 | `10` |
| `SSE_MAX_GLOBAL_CONNECTIONS` | SSE connections allowed process-wide. @default 1000 | `1000` |
| `SSE_RETRY_AFTER_SECONDS` | Seconds advertised to SSE clients after a 429 via Retry-After. @default 15 | `15` |
| `SSE_RETRY_MS` | Milliseconds the browser EventSource waits before reconnecting (sent as SSE retry: directive). @default 5000 | `5000` |
| `WORKER_ENABLED` | Run background queue workers inside this process. @default false | `false` |
| `WS_ALLOWED_ORIGINS` | Comma-separated allowed origins for WebSocket connections. | — |
| `WS_AUTH_REQUIRED` | Require Origin allowlist checks on WebSocket upgrades. @default false | `false` |
| `WS_MAX_CONNECTIONS_PER_IP` | Max concurrent WebSocket connections per client IP. @default 10 | `10` |
| `WS_RECONNECT_LIMIT` | Max WebSocket reconnect attempts per client window. @default 20 | `20` |
| `WS_RECONNECT_WINDOW_MS` | Sliding window for WS reconnect limiting, in ms. @default 60000 | `60000` |

## Indexer

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_STATE_FILE` | File path used to persist admin state (ban list) across restarts. | — |
| `DEPLOYMENT_CHECKLIST_VERSION` | Version stamp recorded against the deployment checklist. @default '2026-03-27' | `2026-03-27` |
| `INDEXER_BACKFILL_BATCH_SIZE` | Number of ledger ranges in a single backfill batch. @default 100 | `100` |
| `INDEXER_BACKFILL_COMMIT_INTERVAL` | Number of ordered batches completed before the checkpoint advances. @default 1 | `1` |
| `INDEXER_BACKFILL_CONCURRENCY` | Maximum number of backfill batches processed concurrently. @default 1 | `1` |
| `INDEXER_BACKFILL_MAX_RETRIES` | Maximum retries for a failed backfill batch. @default 3 | `3` |
| `INDEXER_BACKFILL_RETRY_DELAY_MS` | Delay between backfill batch retries in ms. @default 1000 | `1000` |
| `INDEXER_BACKFILL_STRICT_ORDER` | Require backfill checkpoints to advance in ledger order. @default true | `true` |
| `INDEXER_LAST_SUCCESSFUL_SYNC_AT` | Manually recorded timestamp of the last successful sync, surfaced in status endpoints for operational dashboards. | — |
| `INDEXER_MTLS_REQUIRED` | When true, reject non-TLS indexer worker connections (fail-closed). Defaults to true in production, false otherwise. | — |
| `INDEXER_STALL_THRESHOLD_MS` | Flag the indexer as stalled when no ledger progress for this long, in ms. @default 300000 (5 min) | `300000` |

## Rate limiting

| Variable | Purpose | Default |
|---|---|---|
| `RATE_LIMIT_ADMIN_MAX` | Max admin requests per window. @default 30 | — |
| `RATE_LIMIT_ADMIN_WINDOW_MS` | Sliding window for admin-endpoint limits, in ms. @default 60000 | — |
| `RATE_LIMIT_ALLOWLIST_IPS` | Comma-separated IPs exempt from rate limiting. | — |
| `RATE_LIMIT_APIKEY_MAX` | Max requests per API key per window. @default 600 | — |
| `RATE_LIMIT_APIKEY_WINDOW_MS` | Sliding window for per-API-key limits, in ms. @default 60000 | — |
| `RATE_LIMIT_ENABLED` | Master switch for HTTP rate limiting. @default true | `true` |
| `RATE_LIMIT_IP_MAX` | Max requests per IP per window. @default 100 | — |
| `RATE_LIMIT_IP_WINDOW_MS` | Sliding window for per-IP limits, in ms. @default 60000 | — |
| `RATE_LIMIT_TRUST_PROXY` | Honor X-Forwarded-For from reverse proxies. @default true | `true` |
| `RATE_LIMIT_TRUSTED_PROXIES` | Comma-separated list of trusted proxies for rate-limit keying. | — |
| `TRUSTED_PROXIES` | Comma-separated list of trusted proxy IPs/CIDRs (global fallback). | — |
| `TRUSTED_PROXY_COUNT` | Number of trusted proxies in front of the service (0 = direct). @default 0 | `0` |
| `WS_TRUSTED_PROXIES` | Comma-separated list of trusted proxies for WebSocket client-IP resolution. | — |

## Infrastructure & Ops

| Variable | Purpose | Default |
|---|---|---|
| `AWS_DEFAULT_REGION` | AWS region for S3 backup uploads (SDK fallback variable). | — |
| `AWS_REGION` | AWS region for S3 backup uploads (explicit). | — |
| `CANARY_TRAFFIC_PERCENT` | Percentage of traffic (0–100) to route through the canary code path. 0 disables canary tagging entirely (default). Set to e.g. 10 to tag 10 % of clients deterministically as canary based on a SHA-256 hash of their identity (API key or IP). @default 0 | `0` |
| `DLQ_PURGE_BATCH_SIZE` | Maximum rows to delete per batch in the DLQ retention purge job. Keeps lock duration short on the dead_letter_queue table. Defaults to 500. @default 500 | `500` |
| `DLQ_RETENTION_DAYS` | Retention period in days for dead_letter_queue entries. Entries in a terminal state (status = 'replayed' or permanently failed) older than this many days are eligible for automatic purge. Defaults to 30 days. Set to 0 to disable the purge job entirely. @default 30 | `30` |
| `IDEMPOTENCY_TTL_SECONDS` | Retention window for idempotency keys in seconds (max 7 days). @default 86400 | `86400` |
| `RPC_CB_FAILURE_THRESHOLD` | Failed RPC calls within the window before the circuit opens. @default 5 | `5` |
| `RPC_CB_RESET_TIMEOUT_MS` | Time before an open RPC circuit half-opens, in ms. @default 60000 | `60000` |
| `RPC_CB_WINDOW_MS` | Sliding window for RPC failure counting, in ms. @default 30000 | `30000` |
| `RPC_FALLBACK_CACHE_EARLY_EXPIRY_BETA` | Beta parameter for the fallback cache's early-expiry probabilistic refresh. @default 0 | — |
| `RPC_FALLBACK_CACHE_TTL_SECONDS` | TTL of the RPC fallback cache in seconds. @default 300 | `300` |
| `RPC_HEALTH_CHECK_FAILURE_THRESHOLD` | Consecutive RPC health-check failures before a target is marked unhealthy. @default 3 | `3` |
| `RPC_HEALTH_CHECK_INTERVAL_MS` | Interval between proactive RPC health checks in ms; 0 disables. @default 0 | `0` |
| `RPC_TIMEOUT_MS` | Per-attempt RPC timeout in ms. @default 5000 | `5000` |
| `S3_BACKUP_BUCKET` | S3 bucket holding database backups. @default unset (backups disabled) | — |
| `S3_BACKUP_PREFIX` | Key prefix under which backups are written in S3_BACKUP_BUCKET. | — |
| `STARTUP_PROBE_BUDGET_MS` | Total wall-clock budget for soft-tier startup retries, in ms. @default 30000 | `30000` |
| `STARTUP_PROBE_POSTGRES_TIMEOUT_MS` | Per-attempt timeout for the Postgres (hard-tier) probe, in ms. @default 5000 | `5000` |
| `STARTUP_PROBE_REDIS_TIMEOUT_MS` | Per-attempt timeout for each Redis (soft-tier) retry, in ms. @default 3000 | `3000` |
| `STARTUP_PROBE_STELLAR_TIMEOUT_MS` | Per-attempt timeout for each Stellar RPC (soft-tier) retry, in ms. @default 5000 | `5000` |

