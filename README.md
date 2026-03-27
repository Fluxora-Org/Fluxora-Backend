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
