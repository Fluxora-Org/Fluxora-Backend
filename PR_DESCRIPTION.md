Closes #1437

## Summary

Configuration in `deployment.ts`, `stellar.ts`, `stellarContracts.ts`, `rateLimits.ts`, `health.ts`, and `deprecations.ts` was validated lazily, so an invalid deployment could go unnoticed until a request happened to read the bad setting. Each module now exposes a pure `validate*Config()` function returning one human-readable issue per invalid setting, and a new `validateStartupConfig()` aggregator (`src/config/startupValidation.ts`) runs them all during bootstrap.

Validation is triggered at both startup paths, following the project's existing patterns (no new validation framework):

- **`src/index.ts`** — at the top of the async bootstrap, before dependency probes or socket binding. Throwing lands in the existing `startup:fatal` catch, which logs and exits(1), so a bad deployment fails immediately.
- **`src/app.ts` (`createApp`)** — so tests and embedding apps that build the app with an explicit env object get the same contract. A configuration error can never first surface during request handling.

Errors reuse the existing `ConfigError` from `src/config/env.ts`; its message bullets each invalid setting (e.g. `- RATE_LIMIT_IP_MAX must be an integer >= 1 (got "abc")`), and issues from multiple modules are aggregated into a single startup error.

### Per-module checks

| Module | Startup checks |
| --- | --- |
| `rateLimits.ts` | All `RATE_LIMIT_*` / `WEBHOOK_RETRY_*` integer envs are integers within bounds, including the `MAX_WINDOW_MS` PEXPIRE ceiling on windows; unset values still fall back to defaults |
| `deployment.ts` | `REQUIRE_PARTNER_AUTH`/`REQUIRE_ADMIN_AUTH` demand their tokens; prod-like environments (staging/production) must enable Redis, worker, metrics, and indexer; `DEPLOYMENT_CHECKLIST_VERSION` non-empty |
| `health.ts` | All health/probe timeout & interval knobs are positive integers |
| `stellar.ts` | `horizonUrl` is a valid URL, passphrases non-empty and mutually consistent, pinned contract addresses are valid StrKeys |
| `stellarContracts.ts` | Allowlist entries are valid StrKeys; network passphrases non-empty |
| `deprecations.ts` | Registry entries have valid ISO dates, routes start with `/`, and header-bearing fields contain no CR/LF injection |

## Tests

`src/config/startupValidation.test.ts` (30 cases, all passing) covers:

- Startup succeeds with valid configuration (aggregator + `createApp()`).
- Startup rejects invalid configuration for each configuration module.
- Errors clearly identify the invalid setting.
- Configuration errors are caught at construction/startup, never during request handling.

## Required context: repository repair commit

The repository tip (`5b896b0`) shipped with widespread syntax corruption — severed string literals, dropped tokens, CRLF-injected identifiers in `sseConnectionLimiter.ts`, `backfill.ts`, `replayIntegrity.ts`, `shutdown.ts`, `catchupTelemetry.test.ts`, plus imports of helpers no module exported (`notFound`, `deriveStreamId`, `rowToStreamEventRecord`, …) and an ESLint config that crashed on load. **`tsc --noEmit` failed with 70+ syntax errors and the vitest suite could not import the app, so no change to this repo was verifiable.**

The first commit (`32965fe`) makes only mechanical repairs that restore the evident intent of the surrounding code, each corroborated by an existing call site, sibling code, or an existing test (e.g. `rowToStreamEventRecord` is fully specified by the existing issue-#1316 tests in `tests/db/rowMapping.test.ts`). It includes:

- `tsc --noEmit`: 76 errors → **0** (full strict typecheck clean)
- vitest: suite went from "cannot import app" → 3,932 passing tests
- eslint: config no longer crashes; every file touched by this PR lints with 0 errors

**Known pre-existing issues deliberately not addressed** (unrelated to #1437, documented in the repair commit message): 2 tests in `tests/indexer/catchupTelemetry.test.ts` fail on `IndexerIngestionService` concurrency/checkpoint behavior (the PR #1330 feature appears absent from the tree), and the `errorHandler` 500 fallback shape mismatches `app.test.ts` expectations. The remaining full-suite failures (~200 across 51 files) are integration tests requiring live Postgres/Redis (1508 `ECONNREFUSED` hits) and do not occur in the sandbox.

## Verification performed in this PR

- `pnpm typecheck` → 0 errors
- `pnpm vitest run src/config/startupValidation.test.ts` → 30/30 passing
- Targeted suites for every module touched by the repairs (SSE limiter/emitter, backfill, rowMapping, webhook dispatcher, shutdown, startupValidation) → passing
- `pnpm eslint` on all changed files → 0 errors, 0 new warnings (baseline HEAD had 118 lint errors)
- Full `vitest run` → 3,932 passed / 201 failed (all accounted for above: live-DB integration tests + the two documented pre-existing behavior gaps)

Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>
