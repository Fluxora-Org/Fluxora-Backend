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

## Double-Submit CSRF Cookie Protection

To protect browser-originated clients (such as dashboard applications) against Cross-Site Request Forgery (CSRF), Fluxora implements a Double-Submit CSRF Cookie protection scheme (`src/middleware/csrf.ts`).

### Architecture & Mechanics

1. **Tokens**:
   - **Cookie**: `fluxora_csrf` (random 32-byte hex string, SameSite=Lax/Strict).
   - **Header**: `X-CSRF-Token` (or case-insensitive `x-csrf-token`).

2. **Scope of Enforcement**:
   - **Target Endpoints**: Enforced on mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) to `/api/streams` (and mutating `/api` endpoints).
   - **Safe Methods**: `GET`, `HEAD`, and `OPTIONS` bypass CSRF validation.
   - **Non-Browser Exemption**: Requests authenticated via `Authorization: Bearer <JWT>` or `X-API-Key: <Key>` headers are non-browser/machine-to-machine calls and do not use ambient browser cookies. These requests bypass CSRF checks to maintain backward compatibility with external API integrations.
   - **Cookie-Authenticated Sessions**: Requests that rely on ambient browser cookies (and do not supply Bearer or API-key credentials) MUST present both the `fluxora_csrf` cookie and matching `X-CSRF-Token` header.

3. **Constant-Time Token Comparison**:
   Token comparison is executed in constant time using the same HMAC-SHA256 approach as `src/webhooks/signature.ts`. Both inputs are HMAC-hashed before comparison with `crypto.timingSafeEqual` to eliminate timing side-channels from variable-length inputs:
   ```ts
   const hashA = createHmac('sha256', key).update(cookieToken).digest('hex');
   const hashB = createHmac('sha256', key).update(headerToken).digest('hex');
   const isValid = timingSafeEqual(Buffer.from(hashA, 'utf8'), Buffer.from(hashB, 'utf8'));
   ```

4. **Error Handling**:
   Requests failing CSRF validation return an HTTP `403 Forbidden` JSON envelope with code `FORBIDDEN` and a message specifying whether the CSRF token was missing or mismatched.

### CSRF enforcement behavior (browser-facing requests)

This section spells out the precise enforcement path and important edge-cases to make behaviour explicit for developers and to define the regression surface for tests.

- **When CSRF is enforced**:
   - The middleware enforces CSRF only for mutating HTTP methods: `POST`, `PUT`, `PATCH`, `DELETE`.
   - Enforcement applies only to requests that appear to be cookie-session authenticated (i.e., an ambient `Cookie` header is present and no Authorization or API-key credentials are supplied).

- **Non-enforcement (bypass) rules**:
   - Any non-blank `Authorization` header (e.g., `Bearer <token>`) bypasses CSRF enforcement.
   - Presence of `X-API-Key` header bypasses CSRF enforcement.
   - Presence of `x-api-key` query parameter bypasses CSRF enforcement.
   - Safe methods (`GET`, `HEAD`, `OPTIONS`) bypass CSRF enforcement regardless of authentication method.

- **Token requirements when enforced**:
   - Both a `fluxora_csrf` cookie and an `X-CSRF-Token` header must be present for cookie-authenticated mutating requests.
   - The cookie value is URI-decoded when parsed; the header value is used as supplied (case-insensitive header name lookup is performed).
   - Empty strings for either token are treated as missing and will cause a 403 response.
   - If the header is provided as an array (can occur in some frameworks), the first element is used.

- **Comparison semantics**:
   - Tokens are compared in constant time by HMAC-ing each input and then using `timingSafeEqual` on the digests. This removes timing side-channels associated with variable-length inputs.

- **Error contract (regression surface)**:
   - 403 responses must use the existing JSON envelope with `error.code === 'FORBIDDEN'`.
   - Error messages will indicate whether the failure was due to a missing token or a mismatch, and may include `requestId` when available on the request object.

Include the tests under `tests/middleware/csrf.test.ts` to cover the above edge-cases so behavior remains explicit and regression-safe.

