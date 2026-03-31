# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Today this repository exposes a minimal HTTP surface for stream CRUD and health checks. It now documents both the decimal-string serialization policy for chain/API amounts and the consumer-facing webhook signature verification contract the team intends to keep stable when delivery is enabled.

## Quick Start with Docker Compose

The fastest way to run Fluxora Backend with all dependencies:

```bash
# 1. Clone and navigate to the repository
git clone <repository-url>
cd Fluxora-Backend

# 2. Copy and configure environment variables
cp .env.example .env
# Edit .env with your secrets (JWT_SECRET, API_KEYS, etc.)

# 3. Start with PostgreSQL only
docker-compose up -d

# 4. Or start with PostgreSQL + Redis (full stack)
docker-compose --profile redis up -d

# 5. Check service health
curl http://localhost:3000/health

# 6. View logs
docker-compose logs -f app
```

### Docker Compose Services

| Service | Description | Default URL |
|---------|-------------|-------------|
| `app` | Fluxora Backend API | http://localhost:3000 |
| `postgres` | PostgreSQL 16 database | localhost:5432 |
| `redis` | Redis 7 cache (optional) | localhost:6379 |

### Configuration Profiles

- **Default** (`docker-compose up`): App + PostgreSQL
- **With Redis** (`--profile redis`): App + PostgreSQL + Redis
- **Full Stack** (`--profile full`): All services

### Health Checks

All services include health checks:
- **PostgreSQL**: `pg_isready` every 10s
- **Redis**: `redis-cli ping` every 10s
- **App**: HTTP health endpoint every 30s

The app waits for PostgreSQL to be healthy before starting.

### Database Initialization

PostgreSQL automatically initializes on first run using scripts in `init-db/`:
- `01-schema.sql`: Creates tables, indexes, and initial data
- Streams table for treasury protocol state
- Indexer state tracking
- Audit logs for chain-derived changes
- Webhook delivery tracking (future)

### Troubleshooting

```bash
# Reset everything (destroys data)
docker-compose down -v

# Rebuild after code changes
docker-compose up -d --build

# Check database logs
docker-compose logs postgres

# Connect to database
docker-compose exec postgres psql -U fluxora -d fluxora

# Scale app instances (with external load balancer)
docker-compose up -d --scale app=3
```

## Current status

- Implemented today:
  - REST endpoints for API info, health, and in-memory stream CRUD
  - decimal-string validation for amount fields
  - indexer freshness classification for `healthy`, `starting`, `stalled`, and `not_configured`
  - consumer-side webhook signing and verification helpers in `src/webhooks/signature.ts`
- Explicitly not implemented yet:
  - live webhook delivery endpoints
  - durable delivery logs or replay store
  - persistent database-backed stream/indexer state
  - automated restart orchestration
  - request rate limiting middleware

If a feature in this README is described as a webhook contract, treat it as the documented integration target for consumers and operators, not as proof that the live service already emits webhooks from this repository.

## Decimal String Serialization Policy

All amounts crossing the chain/API boundary are serialized as **decimal strings** to prevent precision loss in JSON.

### Amount Fields

- `depositAmount` - Total deposit as decimal string (for example `"1000000.0000000"`)
- `ratePerSecond` - Streaming rate as decimal string (for example `"0.0000116"`)

### Validation Rules

- Amounts must be strings in decimal notation
- Native JSON numbers are rejected to prevent floating-point precision issues
- Values exceeding safe integer ranges are rejected with `DECIMAL_OUT_OF_RANGE`

### Error Codes

| Code | Description |
|------|-------------|
| `DECIMAL_INVALID_TYPE` | Amount was not a string |
| `DECIMAL_INVALID_FORMAT` | String did not match decimal pattern |
| `DECIMAL_OUT_OF_RANGE` | Value exceeds maximum supported precision |
| `DECIMAL_EMPTY_VALUE` | Amount was empty or null |

## Webhook signature verification for consumers

### Scope and guarantee

For consumer-side verification of Fluxora webhook deliveries, Fluxora aims to guarantee:

- each delivery carries a stable set of verification headers
- the signature is computed over the exact raw request body, not parsed JSON
- consumers can reject stale, oversized, tampered, or duplicate deliveries with predictable outcomes
- operators have a written checklist for diagnosing delivery failures without relying on tribal knowledge

This repository currently provides the canonical algorithm and the expected outcomes. It does not yet provide a live webhook sending service.

### Verification contract

Fluxora webhook deliveries are expected to use these headers:

| Header | Meaning |
|--------|---------|
| `x-fluxora-delivery-id` | Stable id for a single delivery attempt chain; use it for deduplication |
| `x-fluxora-timestamp` | Unix timestamp in seconds |
| `x-fluxora-signature` | Hex-encoded `HMAC-SHA256(secret, timestamp + "." + rawBody)` |
| `x-fluxora-event` | Event name such as `stream.created` or `stream.updated` |

Canonical signing payload:

```text
${timestamp}.${rawRequestBody}
```

Canonical verification rules:

- use the raw request bytes exactly as received
- reject payloads larger than `256 KiB`
- reject timestamps outside a `300` second tolerance window
- compare signatures with a constant-time equality check
- deduplicate on `x-fluxora-delivery-id`

Reference implementation lives in `src/webhooks/signature.ts`.

### Consumer verification example

```ts
import { verifyWebhookSignature } from './src/webhooks/signature.js';

const verification = verifyWebhookSignature({
  secret: process.env.FLUXORA_WEBHOOK_SECRET,
  deliveryId: req.header('x-fluxora-delivery-id') ?? undefined,
  timestamp: req.header('x-fluxora-timestamp') ?? undefined,
  signature: req.header('x-fluxora-signature') ?? undefined,
  rawBody,
  isDuplicateDelivery: (deliveryId) => seenDeliveryIds.has(deliveryId),
});

if (!verification.ok) {
  return res.status(verification.status).json({
    error: verification.code,
    message: verification.message,
  });
}
```

### Trust boundaries

| Actor | Trusted for | Not trusted for |
|-------|-------------|-----------------|
| Public clients | Valid request shape only | Payload integrity, replay prevention |
| Authenticated partners / webhook consumers | Possession of shared webhook secret and endpoint ownership | Skipping signature checks, bypassing replay controls |
| Administrators / operators | Secret rotation, incident response, delivery diagnostics | Reading secrets from logs or bypassing audit trails |
| Internal workers | Constructing signed payloads, retry scheduling, durable delivery state once implemented | Silently mutating or dropping verified deliveries |

### Failure modes and expected behavior

| Condition | Expected result | Suggested HTTP outcome |
|-----------|-----------------|------------------------|
| Missing secret in consumer config | Treat as configuration failure; do not trust the payload | `500` internally, do not acknowledge |
| Missing delivery id / timestamp / signature | Reject as unauthenticated | `401 Unauthorized` |
| Non-numeric or stale timestamp | Reject as replay-risk / invalid input | `400` for malformed timestamp, `401` for stale timestamp |
| Signature mismatch | Reject as unauthenticated | `401 Unauthorized` |
| Payload larger than `256 KiB` | Reject before parsing JSON | `413 Payload Too Large` |
| Duplicate delivery id | Do not process the business action twice | `200 OK` after safe dedupe or `409 Conflict` |
| Consumer overloaded | Ask sender to retry later | `429 Too Many Requests` |

## Health and observability

- `GET /health` returns service status and indexer freshness classification
- request IDs enable correlation across logs
- structured JSON logs are expected for diagnostics
- if `indexer.status = "stalled"`, treat that as an operational signal that chain-derived views would be stale if the real indexer were enabled in this service

## Security headers: helmet middleware

### Service-level outcomes

- every HTTP response carries a predictable baseline of browser-facing security headers
- the service does not advertise Express internals through the `X-Powered-By` header
- operators can verify the header policy with a simple `GET /health` or `GET /` check during rollout and incident response
- failures in downstream dependencies do not disable the security-header baseline because the middleware is applied before route handling

### Trust boundaries

| Actor | May do | May not do |
|-------|--------|------------|
| Public internet clients | Call public routes and observe the documented response headers | Weaken or negotiate a lower security-header policy |
| Authenticated partners | Use partner/admin routes once enabled and receive the same baseline headers | Bypass the default browser-hardening behavior |
| Administrators / operators | Verify header presence through health checks, logs, and smoke tests | Treat the presence of headers as a substitute for auth, input validation, or TLS termination controls |
| Internal workers | Reach internal HTTP surfaces through the same Express stack when applicable | Disable header emission on a per-worker basis |

### Failure modes and expected behavior

| Condition | Expected behavior |
|-----------|-------------------|
| Invalid input or route error | Return the normal error status/body and still emit the security headers |
| Dependency outage | `/health` may report degraded or unavailable state, but the header baseline remains present on the HTTP response |
| Partial data or missing resources | Client receives the documented `404`/`409`/`5xx` behavior with the same header policy intact |
| Duplicate delivery or replayed request | Business logic decides `200`/`409` behavior; the security headers are unchanged because they are orthogonal to idempotency |

### Operator observability and diagnostics

- smoke check with `curl -I http://127.0.0.1:3000/health` and confirm `content-security-policy`, `strict-transport-security`, `x-content-type-options`, and `x-frame-options`
- use structured request logs and request IDs to correlate header checks with the request path under investigation
- if a proxy or CDN strips headers, compare direct-app responses with edge responses to identify where the policy is being altered

### Verification evidence

- automated regression coverage lives in `tests/helmet.test.ts`
- manual verification: `curl -I http://127.0.0.1:3000/` and `curl -I http://127.0.0.1:3000/health`

### Non-goals and audit notes

- this issue adds baseline browser-facing security headers only; it does not replace TLS, authentication, authorization, rate limiting, or CSP tuning for a future browser UI
- residual risk: intermediaries can still overwrite or strip headers, so production verification should include at least one edge-facing probe

## Local setup

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install and run

```bash
npm install
npm run dev
```

API runs at [http://localhost:3000](http://localhost:3000).

### Scripts

- `npm run dev` - run with tsx watch
- `npm run build` - compile to `dist/`
- `npm test` - run the backend test suite plus webhook signature verification tests
- `npm start` - run compiled `dist/index.js`
- `npm run docker:build` - build a production container image
- `npm run docker:run` - run the production container locally
- `npm run docker:smoke` - run a quick container health smoke check

## Production Docker Image (Issue #30)

### Service-level outcomes

- The backend can be packaged and started in a reproducible production image with a single command.
- The container runs as a non-root user and exposes only one HTTP port (`3000` by default).
- Operators get a built-in container health signal via Docker `HEALTHCHECK` against `GET /health`.
- Startup behavior is explicit: the process fails fast if the app cannot boot.

### Trust boundaries for containerized runtime

- Public internet clients: may call read/write API routes (`/`, `/health`, `/api/streams/**`) and receive normalized JSON responses.
- Authenticated partners: currently same HTTP capabilities as public clients (authentication is intentionally deferred and documented).
- Administrators/operators: may configure runtime through environment variables (`PORT`, `LOG_LEVEL`, `INDEXER_*`) and observe health/log output.
- Internal workers: represented by indexer health classification in `/health`; workers are not container-exposed endpoints.

### Failure modes and client-visible behavior

- Invalid input: returns `400` error envelopes from validation middleware.
- Dependency outage or stale worker checkpoint: `/health` reports `degraded` when indexer is `starting` or `stalled`.
- Partial data / missing stream: stream lookups return `404` (`NOT_FOUND`) when absent.
- Duplicate delivery/conflicting transitions: stream cancel path returns `409` (`CONFLICT`) for already-cancelled/completed streams.
- Process-level failure (boot error/panic): container exits non-zero so orchestrators can restart or alert.

### Operator observability and diagnostics

- Health endpoint: `GET /health` for liveness/degraded state, includes indexer freshness summary.
- Container health: Docker health status reflects HTTP health response.
- Logs: structured console logs include request metadata and request/correlation IDs for incident correlation.
- Triage flow:
  - Check `docker ps` health status.
  - Query `/health` and confirm `indexer.status`, `lagMs`, and `summary`.
  - Inspect container logs for request/error context.

### Verification evidence for this issue

Run the following commands:

```bash
npm run docker:build
npm run docker:smoke
```

Optional manual verification:

```bash
docker run --rm -p 3000:3000 fluxora-backend:local
curl -sS http://127.0.0.1:3000/health
```

### Non-goals and follow-up tracking

- This issue does not introduce authentication/authorization for containerized endpoints.
- Follow-up recommendation: add CI job that builds the image and runs `/health` smoke checks on every PR.

## Reorg handling: chain tip safety for indexer

The Fluxora indexer implements strict chain tip safety and reorg handling to ensure the durability and accuracy of chain-derived state.

### Service-level outcomes

- **Chain Tip Safety**: The indexer reports a `lastSafeLedger` which lags the current ingested tip by a safety margin (default 1 ledger for Stellar finality).
- **Reorg Detection**: If an incoming batch contains a ledger number that has already been indexed but with a different `ledgerHash`, the service detects a chain reorg.
- **Automatic Rollback**: Upon reorg detection, the service automatically rolls back its internal state to the ledger before the reorg point and re-indexes the new chain branch.
- **Operator Observability**: Reorgs and safety metrics are exposed via `GET /health` and high-visibility logs.

### Trust boundaries

| Actor | Trusted for | Not trusted for |
|-------|-------------|-----------------|
| Public internet clients | Reading safe ledger state | Determining chain finality |
| Authenticated partners / Indexers | Providing valid ledger hashes | Forcing rollbacks on final ledgers |
| Administrators / Operators | Manual state resets | Mutating individual event records |
| Internal Workers | Detecting reorgs via RPC | Suppressing reorg alerts |

### Failure modes and client-visible behavior

| Condition | Indexer Behavior | Client-visible outcome |
|-----------|------------------|------------------------|
| Chain Reorg detected | Trigger rollback and set `reorgDetected: true` | `GET /health` reports `degraded` during rollback |
| Duplicate delivery | `ON CONFLICT (event_id) DO NOTHING` | `200 OK` (idempotent) |
| Invalid input (missing hash) | Reject batch with `400 Bad Request` | Error envelope with validation details |
| Database outage | Return `503 Service Unavailable` | API reports temporary unavailability |

### Indexer operator observability

- **Health Snapshot**: `GET /health` includes `lastSafeLedger` and `reorgDetected`.
- **Logs**: Reorgs are logged as `WARN` with `existingHash` and `incomingHash` for triage.
- **Triage**: If `reorgDetected` is true, operators should monitor the `lastSafeLedger` to ensure the indexer is making forward progress on the new chain branch.

### Verification evidence

- **Unit Tests**: `src/indexer/reorg.test.ts` simulates reorg scenarios and verifies rollback logic.
- **Manual Check**: Observe `lastSafeLedger` in `/health` increases during ingestion.

## Local setup with Stellar testnet

This section covers everything needed to run Fluxora locally against the Stellar testnet.

### What is the Stellar testnet?

The Stellar testnet is a public test network that mirrors mainnet behaviour but uses test XLM with no real value. It resets periodically (roughly every 3 months). Horizon testnet endpoint: `https://horizon-testnet.stellar.org`.

### Additional prerequisites

- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli) — optional, useful for account inspection
- A Stellar testnet keypair (see below)

### 1. Copy environment file

```bash
cp .env.example .env
```

`.env.example` ships with the testnet defaults already set:

| Variable             | Default value                              | Required |
|----------------------|--------------------------------------------|----------|
| `PORT`               | `3000`                                     | No       |
| `HORIZON_URL`        | `https://horizon-testnet.stellar.org`      | Yes      |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`        | Yes      |

Do **not** commit `.env` — it is listed in `.gitignore`.

### 2. Generate a testnet keypair

You can generate a keypair and fund it with Friendbot in one step:

```bash
# Using Stellar CLI
stellar keys generate --network testnet dev-account

# Or using curl (replace with any new keypair)
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
```

Alternatively, generate a keypair at [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test) — click **Generate Keypair**, then fund it via the Friendbot button.

> Keep the secret key out of version control. Store it only in `.env` or your local secrets manager.

### 3. Verify the testnet account

```bash
curl "https://horizon-testnet.stellar.org/accounts/<YOUR_PUBLIC_KEY>" | jq .
```

A successful response includes `"id"`, `"balances"`, and `"sequence"`. An HTTP 404 means the account is not yet funded — run Friendbot first.

### 4. Install and start the API

```bash
npm install
npm run dev
```

Confirm the server is running:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"fluxora-backend","timestamp":"..."}
```

### 5. Create a test stream

Sender and recipient must be valid Stellar public keys (G…).

```bash
curl -X POST http://localhost:3000/api/streams \
  -H "Content-Type: application/json" \
  -d '{
    "sender": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "recipient": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN",
    "depositAmount": "100",
    "ratePerSecond": "0.001",
    "startTime": 1700000000
  }'
```

### 6. Query streams

```bash
# List all streams
curl http://localhost:3000/api/streams

# Get a specific stream
curl http://localhost:3000/api/streams/<stream-id>
```

### Trust boundaries

| Client type         | Allowed                                      | Not allowed                        |
|---------------------|----------------------------------------------|------------------------------------|
| Public internet     | Read health, list/get/create streams         | Admin operations, raw DB access    |
| Authenticated partner | Future: write operations with JWT          | —                                  |
| Internal workers    | Future: Horizon sync, event processing       | Direct DB writes bypassing API     |

### Failure modes

| Condition                    | Expected behaviour                                        |
|------------------------------|-----------------------------------------------------------|
| Missing required body fields | `400` with a descriptive error message                   |
| Stream ID not found          | `404 { "error": "Stream not found" }`                    |
| Horizon unreachable          | Future: health check returns `503`; streams degrade gracefully |
| Invalid Stellar address      | Future: `400` once address validation is added           |
| Server crash / restart       | In-memory streams are lost (expected until DB is added)  |

### Observability

- `GET /health` — returns `{ status, service, timestamp }`; use this as the liveness probe in any deployment
- Console logs via `tsx watch` show all request activity in development
- Future: structured JSON logging and a `/metrics` endpoint

## Database Backups and Restore Runbook (Issue #52)

### Service-level outcomes
- The backend guarantees a durable, restorable view of chain-derived state using PostgreSQL custom-format dumps.
- Backup operations execute without halting read/write API availability.
- Restore operations execute with a `--clean` flag, guaranteeing the database state exactly matches the backup snapshot, avoiding partial data overlaps.

### Trust boundaries
| Actor | Allowed | Not allowed |
|-------|---------|-------------|
| Public internet clients | No access | Cannot trigger, view, or detect backup/restore operations. |
| Authenticated partners | No access | Cannot trigger or download backups. |
| Internal workers (Cron) | Execute `backupDatabase` routine securely using local FS | Cannot execute restores or drop tables directly. |
| Administrators / operators | Execute `restoreDatabase` during incident response, download dumps from cold storage | Leaving unencrypted dumps on public web servers. |

### Failure modes and expected behavior

| Condition | Expected result | System Behavior |
|-----------|-----------------|-----------------|
| `DATABASE_URL` missing or malformed | Immediate failure before subprocess spawns | `success: false` returned, no partial files created. |
| DB credentials invalid/revoked | Subprocess fails with authentication error | Returns `Backup failed` with `stderr` detail for logs. |
| Disk out of space during backup | `pg_dump` panics mid-stream | Incomplete file remains; operation returns error. Operators must monitor FS capacity. |
| Corrupted or invalid dump file provided to restore | `pg_restore` rejects the archive format | Returns `Restore failed`. Database state remains unchanged (clean drop does not execute). |

### Operator observability and diagnostics
Operators can diagnose backup/restore health without relying on tribal knowledge:
- **Routine Backups:** The backup routine outputs structured JSON containing `{ success: boolean, message: string, error?: string }`.
- **Triage Flow (Backup Failure):**
  1. Check disk space on the volume mapped to the output path.
  2. Verify `DATABASE_URL` validity using `psql`.
  3. Check the `error` string in the logs for `pg_dump` specific stderr (e.g., `FATAL: connection limit exceeded`).
- **Triage Flow (Restore Failure):**
  1. Ensure the target DB has active connections terminated before running a `--clean` restore.
  2. Verify the input file was generated using custom format (`-F c`), as plain SQL dumps will fail `pg_restore`.

### Verification evidence
Automated unit tests (`tests/db-ops.test.ts`) assert the boundaries of the `pg_dump` and `pg_restore` wrappers, including credential failures and missing configurations. 

### Non-goals and follow-up tracking
- **Intentionally deferred:** Automated scheduling (e.g., node-cron) is deferred until persistent volume claims (PVCs) or S3 streaming targets are provisioned in the deployment orchestration.
- **Follow-up:** Add an S3 upload stream integration so dumps don't remain local to the container filesystem.

## GET /api/streams/:id backed by database (Issue #15)

### Service-level outcomes
- The `/api/streams/:id` endpoint provides a durable, highly available read path for chain-derived stream state.
- Values returned respect the Decimal String Serialization Policy to prevent precision loss.

### Trust boundaries
| Actor | Allowed | Not allowed |
|-------|---------|-------------|
| Public internet clients | Can query any known stream ID and receive normalized JSON. | Cannot modify stream state or execute unbounded DB queries (e.g., table scans). |
| Internal workers / Indexer | Trusted to write accurate chain-derived data to the underlying `streams` table. | — |
| Administrators / Operators | Monitor DB latency and connection pool health. | — |

### Failure modes and client-visible behavior
| Condition | Expected result | System Behavior |
|-----------|-----------------|-----------------|
| Valid stream ID exists | `200 OK` | Returns JSON payload with decimal strings. |
| Stream ID does not exist | `404 Not Found` | Returns `{"error": "NOT_FOUND"}`. No DB locks held. |
| Database connection drops | `503 Service Unavailable` | Returns `{"error": "SERVICE_UNAVAILABLE"}`. Logs the underlying `pg` error for operator triage. |

### Operator observability and diagnostics
- **Health Checks:** A `503` from this endpoint indicates pool exhaustion, network partition, or DB credentials failure. Cross-reference with `GET /health`.
- **Diagnostics:** Look for `[GET /api/streams/:id] Database error:` in standard out. This will contain the raw `pg` driver stack trace.

## GET /api/streams filters: status, recipient, sender (Issue #14)

### Service-level outcomes
- Integrators and finance reviewers can deterministically filter the stream index by `status`, `sender`, and `recipient` addresses.
- Filtering is applied prior to cursor-based pagination to guarantee consistent, traversable result sets.

### Trust boundaries
| Actor | Allowed | Not allowed |
|-------|---------|-------------|
| Public internet clients | Can filter public streams by valid addresses and statuses. | Cannot bypass pagination limits or execute wildcard/regex searches. |
| Internal workers / Operators | Full access to filter across all streams for reconciliation. | — |

### Failure modes and client-visible behavior
| Condition | Expected result | System Behavior |
|-----------|-----------------|-----------------|
| Invalid Stellar Address Format | `400 Bad Request` | Fails fast with `VALIDATION_ERROR` indicating exactly which field failed the Regex check. |
| Invalid Status Enum | `400 Bad Request` | Rejects unknown statuses (e.g., `pending`) to prevent cache poisoning or DB errors. |
| Valid filters match no records | `200 OK` | Returns an empty `streams: []` array, not a 404, preserving API list semantics. |

### Operator observability and diagnostics
- Filter parameters are logged alongside `requestId` to help diagnose user reports of "missing streams" (usually caused by a typo in the recipient query).

## API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info |
| GET | `/health` | Health check |
| GET | `/api/streams` | List streams |
| GET | `/api/streams/:id` | Get one stream |
| POST | `/api/streams` | Create stream |

## Project structure

```text
src/
  routes/          # health, streams
  webhooks/        # canonical webhook signing and verification contract
  index.ts         # Express app and server
k6/
  main.js          # k6 entrypoint — composes scenarios
  config.js        # thresholds, stage profiles, base URL
  helpers.js       # shared metrics and payload helpers
  scenarios/       # per-endpoint load scenarios
```

## Load testing (k6)

The `k6/` directory contains a load-testing harness for critical endpoints.

Common commands:

```bash
npm run dev
npm run k6:smoke
npm run k6:load
npm run k6:stress
npm run k6:soak
```

## Chain-First Model

## Environment

Optional:

- `PORT` - server port, default `3000`
- `FLUXORA_WEBHOOK_SECRET` - shared secret for webhook signature verification once delivery is enabled

Likely future additions:

- `DATABASE_URL`
- `REDIS_URL`
- `HORIZON_URL`
- `JWT_SECRET`

## Related repos

- `fluxora-frontend` - dashboard and recipient UI
- `fluxora-contracts` - Soroban smart contracts
```
