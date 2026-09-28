# Authentication Model

This document is the single reference for how Fluxora-Backend authenticates callers. It describes every credential type, the middleware that enforces each one, the route groups each type can access, and how credentials are revoked or expire.

Related reading:
- [`docs/auth.md`](./auth.md) — RBAC permission model, API-key lifecycle, and OIDC flow details
- [`docs/security.md`](./security.md) — broader security controls

---

## 1. Credential Types

### 1.1 JWT Bearer Token

| Property | Value |
|---|---|
| **Header** | `Authorization: Bearer <token>` |
| **Algorithm** | HS256 |
| **Issuer / Audience** | `fluxora` / `fluxora` |
| **Signing secret** | `JWT_SECRET` env var (primary); `JWT_SECRET_PREVIOUS` accepted during rotation |
| **Clock tolerance** | ±10 seconds |
| **Source** | Issued by `POST /api/auth/session` (shared-secret or OIDC path) |

**Token claims**

```
{
  "address": "G...",         // Stellar account address
  "role":    "operator",     // viewer | operator | admin
  "permissions": ["streams:read", ...],
  "jti":     "uuid",         // optional — required for revocation
  "iat": 1234567890,
  "exp": 1234567890
}
```

**Middleware**

- `authenticate()` (`src/middleware/auth.ts`) — optional; attaches `req.user` when a valid token is present; returns `401` for a malformed or revoked token.
- `requireAuth()` — must follow `authenticate()`; returns `401` when `req.user` is absent.
- `requirePermission(permission)` — returns `403` when the caller lacks the named permission.
- `requireScope(...scopes)` — accepts either JWT permissions or API-key scopes.

**Expiry and revocation**

Tokens expire according to their `exp` claim (controlled by `JWT_EXPIRES_IN`, default `24h`). Administrators may revoke an individual token before expiry:

```
POST /api/auth/revoke
Authorization: Bearer <admin-jwt>
{ "jti": "<token-jti>", "exp": <token-exp-unix> }
```

The `jti` is written to Redis (`jwt:revoked:<jti>`) with a TTL equal to the token's remaining lifetime. `authenticate()` calls `isRevoked(jti)` on every JWT that carries a `jti`. If Redis is unavailable the check **fails closed** (token treated as revoked).

---

### 1.2 API Key

| Property | Value |
|---|---|
| **Header** | `X-API-Key: flx_<64 hex chars>` |
| **Prefix** | `flx_` + first 4 hex chars form an 8-char indexed prefix |
| **Storage** | HMAC-SHA256(pepper, salt ‖ rawKey) in `api_keys` table (PostgreSQL) |
| **Pepper** | `API_KEY_PEPPER` env var — never stored in the DB |

**Middleware**

- `authenticateApiKey()` (`src/middleware/auth.ts`) — optional; attaches `req.keyScopes` and `req.keyId` when a valid key is found; returns `401` for a key that exists but is inactive.

**Expiry and revocation**

API keys have no built-in expiry. They are revoked explicitly via the admin endpoint:

```
DELETE /api/admin/api-keys/:id
Authorization: Bearer <ADMIN_API_KEY>
```

Revocation flips `active = false` in PostgreSQL; `authenticateApiKey()` returns `401` immediately on the next request for that key. Every key lifecycle event (`API_KEY_CREATED`, `API_KEY_ROTATED`, `API_KEY_REVOKED`) is written to `audit_logs`.

---

### 1.3 Admin Bearer Token

| Property | Value |
|---|---|
| **Header** | `Authorization: Bearer <token>` |
| **Accepted credentials** | (a) Static token matching `ADMIN_API_KEY` env var, OR (b) Any JWT whose `role` is `admin` or `data-protection-officer` |
| **Comparison** | Constant-time (`crypto.timingSafeEqual`) for the static token |
| **Header size limit** | 8 192 bytes — oversized headers are rejected before any comparison |

**Middleware**

- `requireAdminAuth()` (`src/middleware/adminAuth.ts`) — returns `401` for missing/malformed headers, `403` for invalid credentials, `503` when `ADMIN_API_KEY` is not configured (fail-closed).

**Expiry and revocation**

- Static token: no expiry; rotate by updating `ADMIN_API_KEY` and restarting the service.
- Admin JWT: subject to normal JWT expiry and the jti revocation store (see §1.1).

---

### 1.4 WebSocket JWT

| Property | Value |
|---|---|
| **Header** | `Authorization: Bearer <token>` on the HTTP upgrade request, OR |
| **Query string** | `?token=<token>` |
| **Algorithm** | Same HS256 JWT as §1.1, verified with the same `JWT_SECRET` |
| **Failure codes** | `MISSING_TOKEN`, `INVALID_TOKEN`, `AUTH_NOT_CONFIGURED` |

**Middleware**

- `verifyWsToken(req, secret)` (`src/middleware/tokenAuth.ts`) — returns a discriminated union `{ ok: true, payload }` or `{ ok: false, code }`. Auth failures increment the `fluxora_ws_auth_failure_total` counter and emit a structured warning log. Failures with codes `INVALID_TOKEN` or `AUTH_NOT_CONFIGURED` also write an audit entry.

**Expiry and revocation**

Same as §1.1. The same JWT revocation store is authoritative; the WebSocket handshake handler is responsible for calling `isRevoked(jti)` when enforcement is required.

---

### 1.5 Partner / Internal Static Bearer Token

| Property | Value |
|---|---|
| **Header** | `Authorization: Bearer <token>` |
| **Accepted credential** | A pre-shared static token configured per route (not the same as `ADMIN_API_KEY`) |
| **Roles** | `partner` or `administrator` (configured per-router) |

**Middleware**

- `createBearerTokenAuth(options)` (`src/middleware/tokenAuth.ts`) — factory that returns a middleware enforcing a specific static token. Returns `401` when the token is absent or wrong, `503` when the token is required but not configured.

**Expiry and revocation**

No built-in expiry. Rotate by updating the environment variable that feeds the token and restarting the service.

---

### 1.6 OIDC ID Token

| Property | Value |
|---|---|
| **Submitted in** | `POST /api/auth/session` request body as `{ "idToken": "..." }` |
| **Algorithm** | RS256 (external provider's signing key, fetched via JWKS) |
| **Issuer validation** | Checked against `OIDC_ISSUER_URL` env var |
| **Audience validation** | Checked against `OIDC_AUDIENCE` (client ID) |
| **Replay prevention** | SHA-256 hash stored in Redis with TTL = remaining `exp` lifetime |
| **JWKS cache** | Redis `fluxora:jwks:<issuer>` with 24 h TTL; memory cache aligned |

**Flow summary**

```
Client → POST /api/auth/session { idToken }
       → verifyIdToken() validates sig, iss, aud, exp
       → preventReplay() rejects duplicate tokens
       → generateToken() issues a Fluxora HS256 JWT (§1.1)
       ← 200 { token, user }
```

**Expiry and revocation**

The OIDC ID token is consumed once. The resulting Fluxora JWT follows §1.1 expiry and revocation rules.

---

### 1.7 Indexer Worker Token

| Property | Value |
|---|---|
| **Header** | `x-indexer-worker-token: <token>` |
| **Value** | `INDEXER_WORKER_TOKEN` env var (default `fluxora-dev-indexer-token` in development) |
| **Transport** | All indexer routes also require mTLS (enforced by `mtlsValidationMiddleware`) |

**Middleware**

- `requireIndexerToken(req)` (inline in `src/routes/indexer.ts`) — throws `401` when the header is absent or does not match.
- `mtlsValidationMiddleware` (`src/indexer/mtls.ts`) — applied to the entire `indexerRouter`.

**Expiry and revocation**

No built-in expiry. Rotate by updating `INDEXER_WORKER_TOKEN` and restarting the service.

---

### 1.8 Webhook HMAC Signature

| Property | Value |
|---|---|
| **Headers** | `x-fluxora-signature`, `x-fluxora-timestamp`, `x-fluxora-delivery-id` |
| **Secret** | `FLUXORA_WEBHOOK_SECRET` env var; `FLUXORA_WEBHOOK_SECRET_PREVIOUS` accepted during rotation |
| **Verification** | `verifyWebhookSignature()` (`src/webhooks/signature.ts`) |
| **Deduplication** | `x-fluxora-delivery-id` checked against a Redis-backed dedup cache (24 h TTL) |

This mechanism authenticates **inbound** webhooks sent by external systems to `POST /internal/webhooks/receive`. It is not a user credential.

---

## 2. Auth Lockout

`authLockoutMiddleware` (`src/middleware/authLockout.ts`) runs on `POST /api/auth/session`. It tracks failed attempts by **source IP** and **Stellar address** in a Redis-backed store (`AuthAttemptStore`). When either threshold is exceeded the endpoint returns `429 Too Many Requests` with a `Retry-After` header.

The store is injected via `setAuthAttemptStore()` at startup; when no store is configured the middleware is a no-op.

---

## 3. Roles and Permissions

Roles are embedded in JWTs and govern which permissions a token carries.

| Role | Permissions |
|---|---|
| `viewer` | `streams:read` |
| `operator` | `streams:read`, `streams:write`, `dlq:list`, `dlq:read`, `dlq:replay`, `dlq:delete`, `dlq:consumer:resume`, `audit:read` |
| `admin` | All permissions |

Full permission enum (`src/middleware/auth.ts`):

| Permission | Purpose |
|---|---|
| `streams:read` | Read stream records |
| `streams:write` | Create / mutate streams |
| `admin:pause` | Pause/unpause ingestion; also required to revoke JWTs |
| `admin:reindex` | Trigger reindex operations |
| `indexer:replay` | Trigger and inspect DB replay jobs |
| `dlq:list` | List dead-letter queue entries |
| `dlq:read` | Read individual DLQ entries |
| `dlq:replay` | Replay DLQ entries |
| `dlq:delete` | Delete / purge DLQ entries |
| `dlq:consumer:resume` | Resume suspended DLQ consumers |
| `audit:read` | Read and export the audit log |
| `audit:write` | Internal; write audit entries |

---

## 4. Route-to-Credential Mapping

The table below lists every route group, the credential(s) required, and any additional authorization check. Routes are listed with the path prefix as mounted in `src/app.ts`.

| Route | Method(s) | Credential required | Additional check |
|---|---|---|---|
| `/health` | GET | None | — |
| `/health/ready` | GET | None | — |
| `/health/live` | GET | None | — |
| `/health/deployment` | GET | None | — |
| `/metrics` | GET | Admin Bearer (§1.3) | `requireAdminAuth` |
| `/docs` | GET | None | — |
| `/docs/openapi.json` | GET | None | — |
| `/api/auth/session` | POST | None | Rate-limited by `authLockoutMiddleware`; accepts optional OIDC ID token (§1.6) |
| `/api/auth/revoke` | POST | JWT Bearer (§1.1) | `requirePermission(admin:pause)` |
| `/api/streams` | GET | JWT Bearer (§1.1) or API Key (§1.2) | `authenticateApiKey`, `requireScope(streams:read)` |
| `/api/streams` | POST | JWT Bearer (§1.1) or API Key (§1.2) | `requireAuth`, `requireScope(streams:write)` |
| `/api/streams/:id` | GET | JWT Bearer (§1.1) or API Key (§1.2) | `requireScope(streams:read)` |
| `/api/streams/:id` | PATCH / DELETE | JWT Bearer (§1.1) or API Key (§1.2) | `requireAuth`, `requireScope(streams:write)` |
| `/api/streams/:id/events` (SSE) | GET | Optional JWT Bearer (§1.1) or WS JWT (§1.4) | Auth optional; connection limits apply |
| `/api/admin/status/read-only` | GET | None | Public read of pause-flags only |
| `/api/admin/*` (all other) | ANY | Admin Bearer (§1.3) | `requireAdminAuth` applied at router level |
| `/api/admin/rate-limits/overrides/*` | ANY | Admin Bearer (§1.3) | `requireAdminAuth` applied again on sub-router (defense in depth) |
| `/admin/dlq` | GET | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(dlq:list)` |
| `/admin/dlq/:id` | GET | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(dlq:read)` |
| `/admin/dlq/:id/replay` | POST | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(dlq:replay)` |
| `/admin/dlq/:id` | DELETE | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(dlq:delete)` |
| `/admin/dlq` | DELETE | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(dlq:delete)` |
| `/admin/dlq/consumers/:topic/resume` | POST | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(dlq:consumer:resume)` |
| `/api/audit` | GET | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(audit:read)` |
| `/api/audit/export` | GET | JWT Bearer (§1.1) | `requireAuth`, `requirePermission(audit:read)` |
| `/internal/indexer/contract-events` | POST | Indexer Worker Token (§1.7) + mTLS | `requireIndexerToken` + `mtlsValidationMiddleware` |
| `/internal/indexer/events` | GET | Indexer Worker Token (§1.7) + mTLS | `requireIndexerToken` + `mtlsValidationMiddleware` |
| `/internal/indexer/events/replay` | GET | Indexer Worker Token (§1.7) + mTLS | `requireIndexerToken` + `mtlsValidationMiddleware` |
| `/internal/indexer/events/replay` | POST | JWT Bearer (§1.1) + mTLS | `requireAuth`, `requirePermission(indexer:replay)` + `mtlsValidationMiddleware` |
| `/internal/indexer/status` | GET | JWT Bearer (§1.1) + mTLS | `requireAuth`, `requirePermission(indexer:replay)` + `mtlsValidationMiddleware` |
| `/internal/webhooks/receive` | POST | HMAC Signature (§1.8) | Signature verified by `verifyWebhookSignature`; dedup by delivery ID |
| `/internal/webhooks/*` (all other) | ANY | Admin Bearer (§1.3) | `requireAdminAuth` |
| `/api/privacy/policy` | GET | None | — |
| `/api/privacy/retention` | GET | None | — |
| `/api/privacy/consent` | PUT | None | Address hashed before storage; plaintext never persisted |
| `/api/privacy/consent/:address` | GET | None | Address hashed before lookup |
| `/api/privacy/erasure/:recipientAddress` | DELETE | Admin Bearer (§1.3) | `requireAdminAuth`; DPO-level action |

---

## 5. Credential Interaction

Some routes accept multiple credential types. The precedence rules are:

1. **JWT `authenticate()`** runs first when chained with `authenticateApiKey()`. If a valid `Authorization: Bearer` header is present, `req.user` is set and API-key handling is skipped.
2. **API key** (`X-API-Key` header) runs via `authenticateApiKey()`. On success, `req.keyScopes` and `req.keyId` are set; `req.user` remains unset.
3. **`requireScope()`** accepts either `req.user.permissions` (from JWT) or `req.keyScopes` (from API key), so write operations on `/api/streams` may be authenticated by either mechanism.
4. **Admin Bearer** (`requireAdminAuth`) accepts either the static `ADMIN_API_KEY` token or a JWT whose `role` is `admin` or `data-protection-officer`. It does **not** accept ordinary API keys.

---

## 6. Revocation and Expiry Summary

| Credential | Natural expiry | Revocation mechanism | Revocation storage |
|---|---|---|---|
| JWT Bearer | `exp` claim (default 24 h, controlled by `JWT_EXPIRES_IN`) | `POST /api/auth/revoke` writes `jti` to Redis | `jwt:revoked:<jti>` key with TTL = remaining lifetime |
| API Key | None | `DELETE /api/admin/api-keys/:id` sets `active = false` | PostgreSQL `api_keys.active` column |
| Admin Bearer (static) | None | Rotate `ADMIN_API_KEY` env var and restart | In-process environment variable |
| Admin Bearer (JWT) | `exp` claim | Same as JWT Bearer revocation above | Redis revocation store |
| WebSocket JWT | `exp` claim | Same as JWT Bearer revocation above | Redis revocation store |
| OIDC ID Token | Consumed once; `exp` claim of the resulting JWT applies | Revoke the resulting Fluxora JWT if needed | Redis revocation store |
| Indexer Worker Token | None | Rotate `INDEXER_WORKER_TOKEN` env var and restart | In-process environment variable |
| Webhook HMAC Secret | None | Rotate `FLUXORA_WEBHOOK_SECRET`; old secret accepted via `FLUXORA_WEBHOOK_SECRET_PREVIOUS` | In-process environment variable |

---

## 7. Source File Reference

| File | Responsibility |
|---|---|
| `src/middleware/auth.ts` | `authenticate`, `authenticateApiKey`, `requireAuth`, `requirePermission`, `requireScope`, `Permission` enum, `ROLE_PERMISSIONS` |
| `src/middleware/adminAuth.ts` | `requireAdminAuth` |
| `src/middleware/tokenAuth.ts` | `verifyWsToken`, `createBearerTokenAuth` |
| `src/middleware/authLockout.ts` | `authLockoutMiddleware`, `setAuthAttemptStore` |
| `src/lib/auth.ts` | `generateToken`, `verifyToken` (HS256 sign / verify) |
| `src/lib/apiKey.ts` | `createApiKey`, `rotateApiKey`, `revokeApiKey`, `findRecordByRawKey`, `getApiKeyFromRequest` |
| `src/services/oidcProvider.ts` | `verifyIdToken`, `getJwks`, `preventReplay` |
| `src/redis/jwtRevocationStore.ts` | `revoke`, `isRevoked` |
| `src/redis/authAttemptStore.ts` | `AuthAttemptStore` (lockout backing store) |
| `src/indexer/mtls.ts` | `mtlsValidationMiddleware`, `setMtlsRequired` |
| `src/webhooks/signature.ts` | `verifyWebhookSignature` |
