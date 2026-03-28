# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Today this repository exposes a minimal HTTP surface for stream CRUD and health checks. It now documents both the decimal-string serialization policy for chain/API amounts and the consumer-facing webhook signature verification contract the team intends to keep stable when delivery is enabled.

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
