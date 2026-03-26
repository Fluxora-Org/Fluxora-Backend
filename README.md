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

## API overview

| Method | Path              | Description        |
|--------|-------------------|--------------------|
| GET    | `/`               | API info           |
| GET    | `/health`         | Health check       |
| GET    | `/api/streams`   | List streams       |
| GET    | `/api/streams/:id` | Get one stream   |
| POST   | `/api/streams`   | Create stream (body: sender, recipient, depositAmount, ratePerSecond, startTime) |
| GET    | `/api/rate-limits` | Current client's rate limit status |

All responses are JSON. Stream data is in-memory until you add PostgreSQL.

## Project structure

```
src/
  config/       # Environment config (rateLimits.ts)
  middleware/   # Rate limiter middleware
  routes/       # health, streams, rateLimits
  types/        # Shared types (rateLimit.ts)
  app.ts        # Express app factory
  index.ts      # Server bootstrap
```

## Environment

Optional:

- `PORT` — Server port (default: 3000)

### Rate Limiting

Rate limiting is in-memory (per-process). All clients receive standard headers on every response:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when window resets |

When a limit is exceeded, the response is `429 Too Many Requests` with body:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Retry after 42 seconds.",
    "retryAfter": 42,
    "limit": 100,
    "window": "minute",
    "identifier": "1.2.3.4"
  }
}
```

#### Trust boundaries and limits

| Caller | Limit | Env var |
|--------|-------|---------|
| Anonymous / IP | 100 req/min | `RATE_LIMIT_IP_MAX` / `RATE_LIMIT_IP_WINDOW_MS` |
| Authenticated (API key) | 500 req/min | `RATE_LIMIT_APIKEY_MAX` / `RATE_LIMIT_APIKEY_WINDOW_MS` |
| Admin (X-API-Key matches `ADMIN_API_KEY`) | 2000 req/min | `RATE_LIMIT_ADMIN_MAX` / `RATE_LIMIT_ADMIN_WINDOW_MS` |

The `X-API-Key` header identifies authenticated callers. When absent, the client IP is used. Admin keys take precedence over the authenticated limit.

#### Exempt paths (never rate limited)

- `/` — API info
- `/health` — Health check
- `/api/rate-limits` — Status endpoint itself

#### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `RATE_LIMIT_IP_MAX` | `100` | Max requests per IP per window |
| `RATE_LIMIT_IP_WINDOW_MS` | `60000` | IP window size in ms |
| `RATE_LIMIT_APIKEY_MAX` | `500` | Max requests per API key per window |
| `RATE_LIMIT_APIKEY_WINDOW_MS` | `60000` | API key window size in ms |
| `RATE_LIMIT_ADMIN_MAX` | `2000` | Max requests per admin key per window |
| `RATE_LIMIT_ADMIN_WINDOW_MS` | `60000` | Admin window size in ms |
| `RATE_LIMIT_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` header |
| `ADMIN_API_KEY` | — | Comma-separated admin API keys |

Rate limit identifiers are exposed in logs and error responses. API keys are masked in responses (first 4 + last 4 characters visible).

#### Failure modes

| Scenario | Client-visible behavior |
|----------|----------------------|
| Rate limit exceeded (any tier) | `429 Too Many Requests` with `RATE_LIMIT_EXCEEDED` body, `Retry-After` header, no request data processed |
| `RATE_LIMIT_ENABLED=false` | All requests pass through; no `X-RateLimit-*` headers emitted |
| Server process restarted | Counters reset to zero; clients see full budget on next request |
| Client IP changes mid-window | Counter key changes; client effectively gets fresh budget (by design for anonymous clients) |
| Multiple API keys from same client | Each key has independent counter; no shared budget across keys |
| Malformed or empty `X-API-Key` header | Treated as anonymous IP; IP limit applies |
| Missing `remoteAddress` on socket | Falls back to identifier `"unknown"`; normal rate limiting applies |

#### Observability for operators

**Headers on every response** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` let you observe current window state from any client or load balancer log without additional tooling.

**Status endpoint** — `GET /api/rate-limits` returns the calling client's current rate limit state in JSON. Use this to inspect a specific client's perspective:

```bash
# Check your own rate limit standing
curl -H "X-API-Key: your-key" http://localhost:3000/api/rate-limits
```

**Logs** — Rate limit errors (`429`) emit `RATE_LIMIT_EXCEEDED` with `identifier`, `limit`, `window`, and `retryAfter` fields. These fields are structured for log aggregation tools (Datadog, Grafana, CloudWatch).

**Diagnosis checklist** — When a client reports 429 errors:
1. Check `X-RateLimit-Reset` header — is the window about to refresh?
2. Check `Retry-After` in the 429 body — how many seconds until the client can retry?
3. If multiple clients from same IP are hitting limit — consider raising `RATE_LIMIT_IP_MAX` or moving clients to API-key auth
4. If the status endpoint itself returns 429 — the caller has exhausted their budget before calling it

## Verification

Run the full test suite and build:

```bash
npm install
npm test        # 32 tests — all must pass
npm run build   # TypeScript compilation must be clean
npm audit       # 0 vulnerabilities
```

### Runtime verification (manual)

```bash
# Start server
PORT=3333 RATE_LIMIT_IP_MAX=3 node dist/index.js &

# Exhaust limit
curl -i http://localhost:3333/api/streams
curl -i http://localhost:3333/api/streams
curl -i http://localhost:3333/api/streams

# 4th request must return 429
curl -i http://localhost:3333/api/streams  # HTTP 429, body: RATE_LIMIT_EXCEEDED

# Status endpoint (exempt)
curl -i http://localhost:3333/api/rate-limits  # HTTP 200, shows remaining=0

# Health and root (always exempt, no rate limit headers)
curl http://localhost:3333/health
curl http://localhost:3333/
```

Expected headers on all responses: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

#### Follow-up / non-goals

The following are intentionally out of scope for this implementation:

| Item | Reason |
|------|--------|
| Redis-backed distributed counters | Per-process in-memory counters are sufficient for single-instance deployments. Redis support is a follow-up. |
| Per-stream or per-endpoint limits | Current design is per-client (IP/key). Granular per-route limits add complexity and are not required by the issue. |
| OpenAPI / Swagger documentation | Not required by the issue scope. Can be added as a follow-up if API contract tooling is adopted. |
| Sliding window counters | Current implementation uses fixed-window counters. Simpler to reason about; sliding window can be considered if precise burst control is needed. |
| Background job rate limiting | Internal workers are not exposed externally. Admin-key tier (2000 req/min) handles expected worker traffic. |

## Related repos

- **fluxora-frontend** — Dashboard and recipient UI
- **fluxora-contracts** — Soroban smart contracts

Each is a separate Git repository.
