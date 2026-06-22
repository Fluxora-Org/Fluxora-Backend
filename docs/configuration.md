# Configuration

Fluxora validates environment variables at process startup with `EnvSchema` in `src/config/env.ts`. Invalid or incomplete configuration throws `EnvironmentError` before the Express server binds to a port.

Secret values are never included in validation messages.

## Required variables

| Variable | Type | Notes |
| --- | --- | --- |
| `DATABASE_URL` | URL | PostgreSQL connection string. |
| `JWT_SECRET` | string | Minimum 32 characters. Used to sign API JWTs. |
| `API_KEY_PEPPER` | string | Minimum 32 characters. Required in production for DB-backed API key hashing. |
| `INDEXER_WORKER_TOKEN` | string | Minimum 32 characters. Required by internal indexer routes. |

## Optional variables and defaults

| Variable | Type | Default |
| --- | --- | --- |
| `NODE_ENV` | `development`, `staging`, `production`, `test` | `development` |
| `PORT` | integer, 1-65535 | `3000` |
| `DB_POOL_MIN` | integer, 1-100 | `2` |
| `DB_POOL_MAX` | integer, 1-100 | `10` |
| `DB_CONNECTION_TIMEOUT` | integer ms, 1000-60000 | `5000` |
| `DB_IDLE_TIMEOUT` | integer ms, 1000-600000 | `30000` |
| `REDIS_URL` | URL | `redis://localhost:6379` |
| `REDIS_ENABLED` | boolean | `true` |
| `STELLAR_NETWORK` | `testnet` or `mainnet` | `mainnet` in production, otherwise `testnet` |
| `HORIZON_URL` | URL | Network default |
| `HORIZON_NETWORK_PASSPHRASE` | string | Network default |
| `CONTRACT_ADDRESS_STREAMING` | string | Network default; required to be non-placeholder in production |
| `STELLAR_RPC_URL` | URL | `https://soroban-testnet.stellar.org` |
| `STELLAR_RPC_TIMEOUT` | integer ms | `10000` |
| `STELLAR_RPC_MAX_RETRIES` | integer | `3` |
| `STELLAR_RPC_RETRY_DELAY` | integer ms | `1000` |
| `JWT_EXPIRES_IN` | string | `24h` |
| `API_KEYS` | comma-separated string | Empty, except `test-api-key` in tests |
| `API_KEY_PEPPER` | string | unset outside production |
| `ADMIN_API_KEY` | string | unset |
| `MAX_REQUEST_SIZE` | bytes string, supports `b`, `kb`, `mb`, `gb` | `1mb` |
| `MAX_JSON_DEPTH` | integer, 1-1000 | `20` |
| `REQUEST_TIMEOUT_MS` | integer ms, 1000-300000 | `30000` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `METRICS_ENABLED` | boolean | `true` |
| `CORS_ALLOWED_ORIGINS` | comma-separated origins | unset |
| `TRACING_ENABLED` | boolean | `false` |
| `TRACING_SAMPLE_RATE` | number, 0-1 | `1` |
| `TRACING_OTEL_ENABLED` | boolean | `false` |
| `TRACING_LOG_EVENTS` | boolean | `false` |
| `WEBHOOK_URL` | URL | unset |
| `WEBHOOK_SECRET` | string | unset |
| `WEBHOOK_SECRET_PREVIOUS` | string | unset |
| `FLUXORA_WEBHOOK_SECRET` | string | unset |
| `FLUXORA_WEBHOOK_SECRET_PREVIOUS` | string | unset |
| `WEBHOOK_POLL_INTERVAL_MS` | integer ms | `10000` |
| `WEBHOOK_BATCH_SIZE` | integer, 1-1000 | `10` |
| `ENABLE_STREAM_VALIDATION` | boolean | `true` |
| `ENABLE_RATE_LIMIT` | boolean | `false` in production, otherwise `true` |
| `REQUIRE_PARTNER_AUTH` | boolean | `false` |
| `PARTNER_API_TOKEN` | string | unset |
| `REQUIRE_ADMIN_AUTH` | boolean | `false` |
| `ADMIN_API_TOKEN` | string | unset |
| `WS_AUTH_REQUIRED` | boolean | `false` |
| `INDEXER_ENABLED` | boolean | `false` |
| `WORKER_ENABLED` | boolean | `false` |
| `INDEXER_STALL_THRESHOLD_MS` | integer ms, minimum 1000 | `300000` |
| `INDEXER_LAST_SUCCESSFUL_SYNC_AT` | string | unset |
| `DEPLOYMENT_CHECKLIST_VERSION` | string | `2026-03-27` |
| `ADMIN_STATE_FILE` | path string | unset |
| `RPC_CB_FAILURE_THRESHOLD` | integer | `5` |
| `RPC_CB_WINDOW_MS` | integer ms | `30000` |
| `RPC_CB_RESET_TIMEOUT_MS` | integer ms | `60000` |
| `RPC_TIMEOUT_MS` | integer ms | `5000` |
| `RATE_LIMIT_ENABLED` | boolean | `true` |
| `RATE_LIMIT_IP_WINDOW_MS` | integer ms | route default |
| `RATE_LIMIT_IP_MAX` | integer | route default |
| `RATE_LIMIT_APIKEY_WINDOW_MS` | integer ms | route default |
| `RATE_LIMIT_APIKEY_MAX` | integer | route default |
| `RATE_LIMIT_ADMIN_WINDOW_MS` | integer ms | route default |
| `RATE_LIMIT_ADMIN_MAX` | integer | route default |
| `RATE_LIMIT_TRUST_PROXY` | boolean | `true` |
| `RATE_LIMIT_ALLOWLIST_IPS` | comma-separated IPs | unset |
| `AWS_REGION` | string | unset |
| `AWS_DEFAULT_REGION` | string | unset |
| `FLUXORA_SHUTDOWN` | boolean | unset; internal graceful shutdown flag |

Booleans accept `true`, `false`, `1`, and `0`.

## API key storage

Admin-created API keys are stored in PostgreSQL in the `api_keys` table. The raw key is returned once during create/rotate and is never persisted. Stored rows contain a per-key salt, a peppered HMAC key hash, and a peppered `lookup_hash` derived from the display prefix so validation can use the `api_keys_active_lookup_hash_idx` index instead of scanning every key.

`API_KEY_PEPPER` must be a deployment secret of at least 32 characters. It is required in production and is treated as a secret in configuration validation messages.
