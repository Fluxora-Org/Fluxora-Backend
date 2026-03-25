# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Provides REST endpoints for streams, health checks, and (later) Horizon sync and analytics.

## What's in this repo

- **API Gateway** — REST API for stream CRUD and health
- **Streams API** — List, get, and create stream records (in-memory placeholder; will be replaced by PostgreSQL + Horizon listener)
- Ready to extend with JWT, RBAC, rate limiting, and streaming engine

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

- `npm run dev` — Run with tsx watch (no build)
- `npm run build` — Compile to `dist/`
- `npm start` — Run compiled `dist/index.js`
- `npm test` — Run test suite with Vitest

## API overview

| Method | Path              | Description        |
|--------|-------------------|--------------------|
| GET    | `/`               | API info           |
| GET    | `/health`         | Health check       |
| GET    | `/api/streams`   | List streams       |
| GET    | `/api/streams/:id` | Get one stream   |
| POST   | `/api/streams`   | Create stream (body: sender, recipient, depositAmount, ratePerSecond, startTime) |
| GET    | `/metrics`        | Prometheus metrics (OpenMetrics format) |

All responses are JSON. Stream data is in-memory until you add PostgreSQL.

## Project structure

```
src/
  middleware/ # Express middleware (httpMetrics)
  routes/     # health, streams
  metrics.ts  # Prometheus registry and metric definitions
  index.ts    # Express app and server
tests/
  metrics.test.ts
```

## Environment

Optional:

- `PORT` — Server port (default: 3000)

Later you can add `DATABASE_URL`, `REDIS_URL`, `HORIZON_URL`, `JWT_SECRET`, etc.

## Observability

The `/metrics` endpoint exposes Prometheus-compatible metrics. Point your Prometheus scrape config at the endpoint to collect:

- **Default Node.js metrics** — CPU, memory, event loop lag, GC duration, active handles
- **`http_requests_total`** — Counter partitioned by `method`, `route`, `status_code`
- **`http_request_duration_seconds`** — Histogram of request latency with sensible bucket boundaries

All metrics carry a `service="fluxora-backend"` label. The endpoint returns `text/plain` in Prometheus exposition format.

## Related repos

- **fluxora-frontend** — Dashboard and recipient UI
- **fluxora-contracts** — Soroban smart contracts

Each is a separate Git repository.
