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

## mTLS Client Certificate Validation

The indexer worker uses a mutual TLS (mTLS) connection as a high-value trust boundary between the chain-indexing process and the backend.

To detect misconfiguration or active attacks, any client-certificate validation failure on this connection generates a structured audit log entry (`INDEXER_MTLS_FAILURE`). This log captures:
- The distinct failure reason (e.g., expired certificate, unknown CA, missing certificate).
- The certificate's `subject`, `issuer`, and `serialNumber` (if provided).
- It strictly **excludes** any private key material or full PEM blobs.

Failures also increment the `indexer_mtls_validation_failures_total` Prometheus counter, which includes a `reason` label for granular alerting and faster triage.
