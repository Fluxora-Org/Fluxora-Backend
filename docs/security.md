# Security: SQL Injection and Dependency Audit

## SQL Injection Regression Tests

We exercise repository entrypoints with adversarial inputs to confirm that
parameterized `node-postgres` queries do not allow SQL injection. Tests live
in `tests/security/streamRepository.sqli.test.ts` and use payloads from
`tests/security/fixtures/sqliPayloads.ts`.

When running in CI against a real Postgres instance, ensure the test DB is
isolated and reset between runs.

## Dependency audit (pnpm)

The repository's CI will run `pnpm audit --audit-level=high --json` and
fail the build on any high/critical advisories unless an explicit
exception is recorded in `.pnpm-audit-exceptions` (see CI docs).
