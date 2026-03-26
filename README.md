# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Today this repository exposes a minimal HTTP surface for stream CRUD and health checks. For Issue 54, the service now defines a concrete indexer-stall health classification plus an inline incident runbook so operators can reason about stale chain-derived state without relying on tribal knowledge.

## Decimal String Serialization Policy

All amounts crossing the chain/API boundary are serialized as **decimal strings** to prevent precision loss in JSON.

### Amount Fields

- `depositAmount` - Total deposit as decimal string (e.g., "1000000.0000000")
- `ratePerSecond` - Streaming rate as decimal string (e.g., "0.0000116")

### Validation Rules

- Amounts MUST be strings in decimal notation (e.g., "100", "-50", "0.0000001")
- Native JSON numbers are rejected to prevent floating-point precision issues
- Values exceeding safe integer ranges are rejected with `DECIMAL_OUT_OF_RANGE` error

### Error Codes

| Code                     | Description                               |
| ------------------------ | ----------------------------------------- |
| `DECIMAL_INVALID_TYPE`   | Amount was not a string                   |
| `DECIMAL_INVALID_FORMAT` | String did not match decimal pattern      |
| `DECIMAL_OUT_OF_RANGE`   | Value exceeds maximum supported precision |
| `DECIMAL_EMPTY_VALUE`    | Amount was empty or null                  |

### Trust Boundaries

| Actor                  | Capabilities                               |
| ---------------------- | ------------------------------------------ |
| Public Clients         | Read streams, submit valid decimal strings |
| Authenticated Partners | Create streams with validated amounts      |
| Administrators         | Full access, diagnostic logging            |
| Internal Workers       | Database operations, chain interactions    |

### Failure Modes

| Scenario                 | Behavior                          |
| ------------------------ | --------------------------------- |
| Invalid decimal type     | 400 with `DECIMAL_INVALID_TYPE`   |
| Malformed decimal string | 400 with `DECIMAL_INVALID_FORMAT` |
| Precision overflow       | 400 with `DECIMAL_OUT_OF_RANGE`   |
| Missing required field   | 400 with `VALIDATION_ERROR`       |
| Stream not found         | 404 with `NOT_FOUND`              |

### Operational Notes

#### Diagnostic Logging

Serialization events are logged with context for debugging:

```
Decimal validation failed {"field":"depositAmount","errorCode":"DECIMAL_INVALID_TYPE","requestId":"..."}
```

#### Health Observability

- `GET /health` - Returns service health status
- Request IDs enable correlation across logs
- Structured JSON logs for log aggregation systems

#### Verification Commands

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Build TypeScript
npm run build

# Start server
npm start
```

### Known Limitations

- In-memory stream storage (production requires database integration)
- No Stellar RPC integration (placeholder for chain interactions)
- Rate limiting not implemented (future enhancement)

## What's in this repo

- Implemented today:
  - API info endpoint
  - health endpoint
  - in-memory stream CRUD placeholder
  - indexer freshness classification for `healthy`, `starting`, `stalled`, and `not_configured`
  - health-route reporting for indexer freshness
- Explicitly not implemented yet:
  - a real indexer worker
  - durable checkpoint persistence
  - database-backed chain state
  - automated restart orchestration
  - rate limiting or duplicate-delivery protection

If the health route reports `indexer.status = "stalled"`, treat that as an operational signal that chain-derived views would be stale if the real indexer were enabled in this service.

## Tech stack

- Node.js 18+
- TypeScript
- Express

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
- `npm test` - run the HTTP error-handling tests
- `npm start` - run compiled `dist/index.js`

## API overview

| Method | Path               | Description                                                                      |
| ------ | ------------------ | -------------------------------------------------------------------------------- |
| GET    | `/`                | API info                                                                         |
| GET    | `/health`          | Health check                                                                     |
| GET    | `/api/streams`     | List streams                                                                     |
| GET    | `/api/streams/:id` | Get one stream                                                                   |
| POST   | `/api/streams`     | Create stream (body: sender, recipient, depositAmount, ratePerSecond, startTime) |

Contract guarantees for this area:

## Operational Guidelines

### Trust Boundaries
- **Public API**: The `/api/streams/lookup` endpoint is accessible to any client with stream IDs. Currently, no authentication is enforced.
- **Failures**: Invalid JSON or missing `ids` array returns `400 Bad Request`. Non-existent IDs are silently omitted from the response to prevent information leakage and ensure robustness for partial matches.

### Health and Observability
- **Success Metrics**: Monitor `200 OK` responses for the lookup endpoint.
- **Error Monitoring**: Track `400` errors for client integration issues.
- **Diagnostics**: If streams are not found, verify the stream creation logs or ensure the in-memory state hasn't been reset by a restart.

## Project structure
...

This is sufficient for local diagnosis now. If Redis, PostgreSQL, Horizon RPC, or workers are added later, their outage classifications should be folded into the same logging pattern.

### Verification evidence

Automated tests in `src/app.test.ts` cover:

- normalized `404` for unknown routes
- normalized `400` for invalid JSON
- normalized `413` for oversized payloads
- normalized `400` for route validation failures
- normalized `500` for unexpected exceptions

Build verification:

```bash
npm test
npm run build
```

### Non-goals and follow-up work

Intentionally deferred in this issue:

- rate limiting implementation
- duplicate-submission detection
- persistence-backed failure classification
- OpenAPI generation for error schemas

Recommended follow-up issues:

- add rate limiting that returns normalized `429` errors
- add idempotency / duplicate-submission protection
- publish OpenAPI schemas for the normalized error envelope
- extend dependency-outage classification once real database / indexing integrations land

## Project structure

```text
src/
  routes/     # health, streams
  index.ts    # Express app and server
k6/
  main.js     # k6 entrypoint — composes all scenarios
  config.js   # Thresholds, stage profiles, base URL
  helpers.js  # Shared metrics, check utilities, payload generators
  scenarios/
    health.js          # GET /health
    streams-list.js    # GET /api/streams
    streams-get.js     # GET /api/streams/:id (200 + 404 paths)
    streams-create.js  # POST /api/streams (valid + edge cases)
```

## Load testing (k6)

The `k6/` directory contains a [k6](https://k6.io/) load-testing harness for all critical endpoints.

### Prerequisites

Install k6 ([docs](https://grafana.com/docs/k6/latest/set-up/install-k6/)):

```bash
# macOS
brew install k6

# Windows (winget)
winget install k6 --source winget

# Windows (choco)
choco install k6

# Docker
docker pull grafana/k6
```

### Running

Start the API in one terminal:

```bash
npm run dev
```

Run a load test profile in another:

```bash
# Smoke (default — 5 VUs, 1 min, good for CI)
npm run k6:smoke

# Load (50 VUs, 5 min)
npm run k6:load

# Stress (ramp to 200 VUs)
npm run k6:stress

# Soak (30 VUs, 24 min — memory leak detection)
npm run k6:soak
```

Override the target URL for staging/production:

```bash
k6 run -e PROFILE=load -e K6_BASE_URL=https://staging.fluxora.io k6/main.js
```

### Profiles

| Profile | VUs   | Duration | Purpose                          |
|---------|-------|----------|----------------------------------|
| smoke   | 5     | 1 min    | CI gate / sanity check           |
| load    | 50    | 5 min    | Pre-release regression           |
| stress  | → 200 | 6 min    | Capacity ceiling / breaking point|
| soak    | 30    | 24 min   | Memory leaks / drift detection   |

### SLO thresholds

| Metric                 | Target         |
|------------------------|----------------|
| p(95) response time    | < 500 ms       |
| p(99) response time    | < 1 000 ms     |
| Error rate             | < 1 %          |
| Health p(99) latency   | < 200 ms       |

If any threshold is breached, k6 exits with a non-zero code — suitable for CI gates.

### Scenarios covered

- **health** — `GET /health` readiness probe; must never fail.
- **streams_list** — `GET /api/streams`; validates JSON array response.
- **streams_get** — `GET /api/streams/:id`; exercises both 200 (existing) and 404 (missing) paths.
- **streams_create** — `POST /api/streams`; valid payloads (201) and empty-body edge case.

### Trust boundaries modelled

| Boundary           | Endpoints                            | Notes |
|--------------------|--------------------------------------|-------|
| Public internet    | GET /health, GET /api/streams[/:id]  | Read-only, unauthenticated |
| Partner (future)   | POST /api/streams                    | Auth not yet enforced — tracked as follow-up |

### Failure modes tested

| Mode                    | Expected client behavior           | Covered by        |
|-------------------------|------------------------------------|--------------------|
| Missing stream ID       | 404 `{ error: "Stream not found" }`| streams-get        |
| Empty POST body         | Service defaults fields (201)      | streams-create     |
| Latency degradation     | Thresholds catch p95/p99 drift     | All scenarios      |

### Intentional non-goals (follow-up)

- **Auth header injection**: No JWT layer yet; will add when auth middleware lands.
- **Database failure injection**: In-memory store only; re-run after PostgreSQL migration.
- **Stellar RPC dependency simulation**: Requires contract integration work.
- **Rate-limiting verification**: Rate limiter not yet implemented.

### Observability / incident diagnosis

Operators can diagnose load-test runs via:

1. **k6 terminal summary** — real-time VU count, latency percentiles, error rate.
2. **k6 JSON output** — `k6 run --out json=results.json k6/main.js` for post-hoc analysis.
3. **Grafana Cloud k6** — `k6 cloud k6/main.js` streams results to a dashboard (requires account).

## Environment

Optional:

- `PORT` - server port, default `3000`

Likely future additions:

- `DATABASE_URL`
- `REDIS_URL`
- `HORIZON_URL`
- `JWT_SECRET`

## Related repos

- `fluxora-frontend` - dashboard and recipient UI
- `fluxora-contracts` - Soroban smart contracts
