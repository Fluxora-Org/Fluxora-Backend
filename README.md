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

| Method | Path                | Description        |
|--------|---------------------|--------------------|
| GET    | `/`                 | API info           |
| GET    | `/health`           | Health check       |
| GET    | `/api/streams`      | List streams       |
| GET    | `/api/streams/:id`  | Get one stream     |
| POST   | `/api/streams`      | Create stream      |

**POST `/api/streams` request body:**

```json
{
  "sender": "G...",
  "recipient": "G...",
  "depositAmount": "100",
  "ratePerSecond": "0.001",
  "startTime": 1700000000
}
```

All responses are JSON. Stream data is in-memory until PostgreSQL is added.

## Project structure

```
src/
  routes/     # health, streams
  index.ts    # Express app and server
.env.example  # Environment variable template
```

## Environment

| Variable             | Default                                    | Description                        |
|----------------------|--------------------------------------------|------------------------------------|
| `PORT`               | `3000`                                     | HTTP server port                   |
| `HORIZON_URL`        | `https://horizon-testnet.stellar.org`      | Stellar Horizon endpoint           |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`        | Stellar network identifier         |

Copy `.env.example` to `.env` and adjust values for your environment. Mainnet passphrase is `Public Global Stellar Network ; September 2015`.

## Related repos

- **fluxora-frontend** — Dashboard and recipient UI
- **fluxora-contracts** — Soroban smart contracts

Each is a separate Git repository.
