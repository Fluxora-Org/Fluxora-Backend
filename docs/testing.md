# Fluxora Integration Testing: Admin Routes

This document provides a concise overview of the integration test suites covering the administrative route surface in `src/routes/admin.ts` and the Dead-Letter Queue (DLQ) surface in `src/routes/dlq.ts`.

## Structure

Admin integration tests are divided into isolated vitest suites under `tests/routes/`:
- `admin.pause.test.ts`: Toggling operational pause flags and read-only status.
- `admin.reindex.test.ts`: Triggering and checking background reindexing.
- `admin.apiKeys.test.ts`: Creating, listing, and revoking API keys.
- `admin.dlq.test.ts`: Standard operator access to the Dead-Letter Queue.

## Authentication Patterns

Administrative and operational endpoints require credentials depending on their mounting context:
1. **General Admin Endpoints (`/api/admin/*`)**:
   Protected by `requireAdminAuth`, verifying that a request's `Authorization: Bearer <ADMIN_API_KEY>` matches `process.env.ADMIN_API_KEY`.
2. **Dead-Letter Queue Endpoints (`/admin/dlq/*`)**:
   Protected by `authenticate`, `requireAuth`, and `requireOperator`, requiring a valid JWT issued to an address with `role: 'operator'`.

## State Isolation & Resets

To ensure deterministic behavior and prevent test-to-test side effects, in-process state is initialized and purged in `beforeEach`/`afterEach` hooks:
- **Pause & Reindex State**: Cleared using `_resetForTest()` from `src/state/adminState.ts`.
- **API Key Records**: Cleared using `_resetApiKeyStoreForTest()` from `src/lib/apiKey.ts`.
- **DLQ Entries**: Cleared using `_resetDlq()` from `src/routes/dlq.ts`.

## Supertest Integration

All endpoints are tested by running requests against the in-process Express application (`app` from `src/app.js`):

```typescript
import request from 'supertest';
import { app } from '../../src/app.js';

const res = await request(app)
  .get('/api/admin/pause')
  .set('Authorization', `Bearer \${process.env.ADMIN_API_KEY}`);
```

---

## End-to-End (E2E) Tests

E2E tests live in `tests/e2e/` and exercise the full stack: HTTP → Express → PostgreSQL → (optionally) Stellar testnet RPC.

### Test file

`tests/e2e/streams.e2e.test.ts` covers the complete stream lifecycle:

| Scenario | Expected outcome |
|---|---|
| `GET /health` | 200 `{ status: 'ok' }` |
| `POST /api/streams` (valid) | 201, decimal-string amounts |
| `POST /api/streams` (same Idempotency-Key) | 201 replay, `Idempotency-Replayed: true` header |
| `POST /api/streams` (missing Idempotency-Key) | 400 |
| `POST /api/streams` (numeric amount) | 400 |
| `GET /api/streams/:id` (exists) | 200 with stream data |
| `GET /api/streams/:id` (unknown) | 404 |
| `GET /api/streams` | 200, non-empty list |
| `DELETE /api/streams/:id` | 200 or 401 (auth-dependent) |
| Security headers | `x-content-type-options: nosniff` present |

### Running locally (offline — no database required)

The test mocks the DB layer automatically when `DATABASE_URL` is not set:

```bash
pnpm test tests/e2e/streams.e2e.test.ts
```

### Running locally against a real database

```bash
# Start PostgreSQL (e.g. via Docker Compose)
docker-compose up -d postgres

# Run migrations
DATABASE_URL=postgres://fluxora:fluxora@localhost:5432/fluxora pnpm run build && node dist/db/migrate.js

# Run e2e tests
DATABASE_URL=postgres://fluxora:fluxora@localhost:5432/fluxora pnpm test tests/e2e/streams.e2e.test.ts
```

### Nightly CI workflow

`.github/workflows/e2e.yml` runs automatically at **02:00 UTC** every night (and can be triggered manually via `workflow_dispatch`).

It:
1. Spins up a `postgres:16` service container.
2. Injects secrets from GitHub repository secrets (see table below).
3. Runs database migrations.
4. Executes `pnpm vitest run tests/e2e` with `VITEST_RETRY=1` to tolerate transient testnet RPC timeouts.

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `E2E_DB_PASSWORD` | Password for the ephemeral PostgreSQL service container |
| `E2E_HORIZON_URL` | Stellar Horizon endpoint, e.g. `https://horizon-testnet.stellar.org` |
| `E2E_NETWORK_PASSPHRASE` | Stellar network passphrase, e.g. `Test SDF Network ; September 2015` |
| `E2E_JWT_SECRET` | HS256 secret used to sign test JWTs |

> Secrets are never echoed in logs. `DATABASE_URL` is constructed from `E2E_DB_PASSWORD` inside the workflow and is not stored as a separate secret.

### Security notes

- Secrets are injected only into the e2e workflow job; they are not available to PR builds from forks.
- The workflow uses `timeout-minutes: 30` to prevent runaway jobs from consuming CI minutes.
- `VITEST_RETRY=1` retries each test once on failure to handle testnet flakiness without masking real bugs (a second failure is still reported).

