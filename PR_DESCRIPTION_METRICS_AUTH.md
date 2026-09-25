# Pull Request: Assert metrics endpoint is not publicly reachable

Closes #1476

## Summary

This PR restricts and formalizes access to the Prometheus scrape endpoint (`GET /metrics`), ensuring internal operational metrics (traffic volumes, error rates, tenant counts, and component names) are not publicly reachable without credentials.

### Key Changes

1. **Authorization & Refusal Logging (`src/middleware/adminAuth.ts`)**:
   - `requireAdminAuth` enforces strict authentication on `GET /metrics` via Bearer token matching `ADMIN_API_KEY` or a verified JWT with `admin` or `data-protection-officer` role.
   - Refusal events are now structured and logged using `warn(...)` across all failure branches:
     - Unconfigured `ADMIN_API_KEY` (503 Service Unavailable)
     - Missing `Authorization` header (401 Unauthorized)
     - Oversized header exceeding 8 KiB limit (401 Unauthorized)
     - Malformed or non-Bearer scheme (401 Unauthorized)
     - Missing or empty Bearer token (401 Unauthorized)
     - Invalid credentials or insufficient role (403 Forbidden)
   - Refusal logs capture correlation ID, path, method, and client IP, while strictly ensuring credential material and raw tokens are never logged.

2. **OpenAPI 3.1 Specification (`src/openapi/spec.ts`)**:
   - Documented the security requirement for `GET /metrics` with `security: [{ bearerAuth: [] }]`.
   - Added descriptive summaries and response codes: `200` (Prometheus metrics), `401` (Unauthorized), `403` (Forbidden), and `503` (Service Unavailable).

3. **Documentation (`src/routes/metrics.ts` & `docs/observability.md`)**:
   - Updated route JSDoc in `src/routes/metrics.ts` with explicit documentation on:
     - Authorization requirements (`ADMIN_API_KEY` or admin JWT)
     - Network interface boundary recommendations (restricting `/metrics` to internal management networks, VPCs, or loopback)
     - Refusal and logging behaviors
     - Bounded label cardinality guarantees
   - Expanded `docs/observability.md` with a dedicated section on scrape configuration, access control, response codes, logging behavior, and network interface isolation.

4. **Testing & Validation**:
   - Created a dedicated unit test suite for the module: `src/routes/metrics.test.ts` (10 tests).
   - Hardened integration test suite: `tests/routes/metrics.auth.test.ts` (7 tests).
   - Verified that uncredentialed requests from external origins are refused and logged.
   - Verified that no high-cardinality label or per-user data (Stellar public addresses, emails, user IDs, or API keys) is exposed in the scrape payload.

## Acceptance Criteria Verification

| Acceptance Criterion | Status | Evidence |
|----------------------|--------|----------|
| **Endpoint requires authorisation or internal interface binding** | Verified | Gated by `requireAdminAuth`; Prometheus jobs must present `Bearer <ADMIN_API_KEY>` or admin JWT. Documented reverse proxy / network binding recommendations. |
| **Access rule is documented** | Verified | Documented in `src/routes/metrics.ts`, `src/openapi/spec.ts` (OpenAPI 3.1 `bearerAuth`), and `docs/observability.md`. |
| **Unauthorised access is refused and logged** | Verified | Rejections return 401/403/503 and trigger structured `warn()` logs with metadata (`path`, `method`, `ip`, `correlationId`) without leaking credential material. |
| **No high-cardinality label exposes per-user data** | Verified | Automated tests scan `/metrics` payload and ensure no wallet addresses (`G...`), emails, user IDs, or secrets are present in label sets. |
| **Validation: Request without credentials returns refusal** | Verified | Tested via Supertest; unauthenticated `GET /metrics` returns 401 Unauthorized and logs warning. |

## Verification Commands

```bash
# Run metrics test suites
pnpm test src/routes/metrics.test.ts tests/routes/metrics.auth.test.ts tests/metrics.test.ts

# Run admin auth tests to ensure no regressions
pnpm test tests/middleware/adminAuth.test.ts tests/routes/admin.auth.test.ts

# Verify OpenAPI spec documentation
pnpm test src/routes/docs.test.ts
```
