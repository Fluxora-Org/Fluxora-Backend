# Testing Guide

## Test Runner

The project uses **Vitest** as its single test runner. Previously the repository
had a mix of Jest and Vitest configurations, which meant some Vitest-only specs
were never executed under CI. All test files now use Vitest imports or globals.

### Rationale

-   **Single source of truth** — one runner, one config, one coverage provider.
-   **v8 coverage** — Vitest's built-in `@vitest/coverage-v8` produces
    `lcov.info` output that Codecov consumes directly.
-   **ESM-native** — Vitest handles TypeScript and ESM without ts-jest or
    separate transformers.
-   **Performance** — Vitest re-uses Vite's transform pipeline, making
    incremental test runs significantly faster.

Administrative and operational endpoints require credentials depending on their mounting context:
1. **General Admin Endpoints (`/api/admin/*`)**:
   Protected by `requireAdminAuth`, verifying that a request's `Authorization: Bearer <ADMIN_API_KEY>` matches `process.env.ADMIN_API_KEY`.
2. **Dead-Letter Queue Endpoints (`/admin/dlq/*`)**:
   Protected by `authenticate`, `requireAuth`, and `requireOperator`, requiring a valid JWT issued to an address with `role: 'operator'`.

## State Isolation & Resets

To ensure deterministic behavior and prevent test-to-test side effects, in-process state is initialized and purged in `beforeEach`/`afterEach` hooks:
- **Pause & Reindex State**: Cleared using `_resetForTest()` from `src/state/adminState.ts`.
- **API Key Records**: Persisted in PostgreSQL via `apiKeyRepository`. Tests inject an in-memory fake of `src/db/repositories/apiKeyRepository.ts` (see `tests/lib/auth.test.ts`) and reset it in `beforeEach`.
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

## Running Tests

```bash
# Run all tests once
pnpm test

# Run with coverage (generates ./coverage/lcov.info)
pnpm run test:coverage

# Watch mode for development
pnpm run test:watch

# Run a single test file
pnpm vitest run tests/routes/admin.test.ts

# Run tests matching a pattern
pnpm vitest run --reporter=verbose tests/routes/
```

## Coverage

Coverage is configured in `vitest.config.ts` with the v8 provider:

-   **Source**: `src/**/*.ts` (excluding `src/index.ts`)
-   **Output**: `./coverage/` (includes `lcov.info` for Codecov)
-   **Thresholds**: 80% across lines, functions, branches, and statements

## Test File Locations

| Location | Contents |
|---|---|
| `tests/` | Unit and integration tests |
| `tests/routes/` | HTTP route handler tests |
| `tests/e2e/` | End-to-end tests (require PostgreSQL) |
| `tests/unit/` | Pure unit tests |
| `src/*.test.ts` | Co-located unit tests alongside source |
| `tests/security/` | Security-focused tests (SQL injection, etc.) |

## Test Setup

`tests/setup.ts` runs before every test file. It sets safe environment defaults
for test mode:

-   `NODE_ENV=test`
-   `RATE_LIMIT_ENABLED=false`
-   `REDIS_ENABLED=false` (tests use in-memory fakes)
-   `DATABASE_URL` defaults to a local non-production URL
-   `JWT_SECRET` and `INDEXER_WORKER_TOKEN` use test-only values

No test file connects to a real database, Redis, or RPC endpoint unless it
explicitly sets up those services.

## CI Pipeline

The CI workflow (`.github/workflows/ci.yml`) runs `pnpm test:coverage` which
executes Vitest with coverage. The resulting `./coverage/lcov.info` is uploaded
to Codecov.

## Security Notes

-   Test setup does not load production secrets.
-   Coverage artifacts contain only code paths, not environment values.
-   CI uses `pnpm audit` for dependency vulnerability scanning.
