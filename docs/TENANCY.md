# Tenant Isolation — Fluxora Backend

> **Security invariant**: a normal tenant-scoped request can only read or
> modify data belonging to its authenticated tenant. Cross-tenant administrative
> access is a deliberate, explicit operation and is fully auditable.

This document describes how multi-tenant isolation is implemented in
Fluxora-Backend, what resources are tenant-scoped, how the isolation is
enforced structurally, and the rules developers must follow when adding new
tenant-scoped queries.

---

## 1. Tenant Identity

A **tenant** is identified by its Stellar public key (Ed25519, Bech32 format).

Every authenticated HTTP request carries a signed JWT whose payload contains:

```json
{
  "address": "GCSZQZ4E3QKBZLNBSAFJHFWBBXUGGD4ZMXDJ3PXQZL8STQVJZLHZQNA",
  "role": "operator",
  "permissions": ["streams:read", "streams:write", ...]
}
```

The `address` field is the stable, globally-unique tenant identifier used
throughout the application stack.

---

## 2. How the Tenant Identity Flows into the Stack

```
Client HTTP request
  ↓
Authorization: Bearer <JWT>
  ↓
authenticate()            (src/middleware/auth.ts)
  → verifies JWT signature
  → attaches req.user.address  ← tenant identity
  ↓
requireAuth / requireScope
  → rejects if no valid credential
  ↓
enforceStreamScope()      (src/routes/streams.ts)
  → req.callerAddress = req.user.address
  ↓
Route handler
  → passes callerAddress / tenantId to repository
  ↓
setTenantContext()        (src/db/repositories/tenantScopedRepository.ts)
  → pushes { tenantId, principal, isAdmin } onto context stack
  ↓
findForTenant / getForTenant / findDlqEntriesForTenant …
  → WHERE sender_address = $tenantId  (streams)
  → WHERE tenant_id = $tenantId       (DLQ)
  ↓
PostgreSQL
```

---

## 3. Tenant-Scoped Resources

| Resource            | Table                      | Tenant column      | Enforcement layer      |
|---------------------|----------------------------|--------------------|------------------------|
| Streams             | `streams`                  | `sender_address`   | `streamRepository.getForTenant`, `findForTenant` |
| Dead-letter queue   | `dead_letter_queue`        | `tenant_id`        | `dlqRepository.findAll({ tenantId })` |
| Idempotency keys    | Redis keys                 | key prefix         | `idempotencyStore` prefixed by tenant address |

> **Note on the `streams` table**: The `streams` table does not have a
> dedicated `tenant_id` column. The `sender_address` column serves as the
> tenant identifier, which equals the authenticated principal's Stellar address.
> All tenant-scoped queries apply `WHERE sender_address = $tenantId`.

---

## 4. Structural Isolation Enforcement

Tenant isolation is **structural** — it is enforced by the repository layer,
not by individual handler conventions.

### 4.1 `TenantScopedRepository` (the structural gate)

`src/db/repositories/tenantScopedRepository.ts` provides the sole entry point
for tenant-scoped queries.  It uses a request-scoped context stack:

```typescript
setTenantContext(tenantId, principal, isAdmin);
// … later …
const ctx = currentTenantContext();
if (!ctx) throw new NoTenantError();
// ctx.tenantId is now the only tenant id that can reach the DB
```

All public tenant-scoped APIs in this file (`getStreamForTenant`,
`findStreamsForTenant`, `findDlqEntriesForTenant`, …) call
`currentTenantContext()` before touching the database. If no context is set,
a `NoTenantError` is thrown — the query never reaches the database.

### 4.2 `streamRepository.getForTenant` (the per-record guard)

`src/db/repositories/streamRepository.ts` provides `getForTenant`:

```typescript
export async function getForTenant(tenantId: string, id: string) {
  const record = await streamRepository.getById(id);
  if (!record) return undefined;
  if (record.sender_address !== tenantId) return undefined; // hidden, not leaked
  return record;
}
```

A cross-tenant fetch via ID returns `undefined`, which causes the route
to respond with **404** (the existence of the resource is hidden).

### 4.3 `streamRepository.findForTenant` (list query guard)

```typescript
export async function findForTenant(tenantId, filter, pagination) {
  return streamRepository.findWithCursor(
    { ...filter, sender_address: tenantId },  // ← tenant constraint injected
    …
  );
}
```

The `sender_address` predicate is injected unconditionally so no list query
can omit the tenant filter.

### 4.4 `enforceStreamScope` (route-level guard, defense-in-depth)

`src/routes/streams.ts` also validates that the caller's `sender` / `recipient`
query parameters match `req.callerAddress`:

```typescript
if (senderFilter && senderFilter !== req.callerAddress) {
  throw forbidden('You are not authorized to query streams for this sender');
}
```

This is an additional guard; the primary structural isolation lives in the
repository layer above.

---

## 5. Developer Rules for New Tenant-Scoped Queries

> **Rule**: every new query against a tenant-owned table must go through the
> `tenantScopedRepository` or the per-tenant helpers in `streamRepository`.
> Direct calls to `streamRepository.find()` or `streamRepository.findWithCursor()`
> without a `sender_address` filter are **not permitted** for tenant-scoped paths.

### Adding a new tenant-scoped stream query

1. Call `setTenantContext(tenantId, principal, isAdmin)` at the start of the
   request lifecycle (or verify it is already set by `enforceStreamScope`).
2. Use `findStreamsForTenant(filter, pagination)` or `getStreamForTenant(id)`.
3. **Never** call `streamRepository.find()` or `streamRepository.findWithCursor()`
   without including `{ sender_address: tenantId }` in the filter.

### Adding a new tenant-scoped DLQ query

1. Use `findDlqEntriesForTenant(opts)` or `getDlqEntryForTenant(id)`.
2. These functions call `dlqRepository.findAll({ ...opts, tenantId })` which
   applies `WHERE tenant_id = $tenantId`.

### Adding a new tenant-scoped resource (new table)

1. Ensure the table has either a `tenant_id` column or uses `sender_address`
   as the tenant identifier (document the convention explicitly).
2. Add per-tenant helpers in the repository file analogous to `getForTenant`
   and `findForTenant`.
3. Wire them through a new set of scoped wrappers in `tenantScopedRepository.ts`.

---

## 6. Intentionally Global (Non-Tenant-Scoped) Resources

The following resources are **platform-global** by design.  Do not add tenant
filtering to them.

| Resource                     | Table / Service                   | Rationale                                        |
|------------------------------|-----------------------------------|--------------------------------------------------|
| Tenant rate-limit overrides  | `tenant_rate_limit_overrides`     | Keyed by `key_id` (API key), not by tenant; admin-only |
| API keys                     | `api_keys`                        | Admin-managed; not per-tenant-owned              |
| Indexer state                | `indexer_replay_progress`, etc.   | Platform-global indexer bookkeeping              |
| Webhook outbox               | `webhook_outbox`                  | Delivery infra, cross-tenant                     |
| Audit log                    | `audit_log`                       | Immutable platform log; admin-read only          |
| Contract events              | `contract_events`                 | Chain data; not tenant-owned                     |
| Privacy consents             | `privacy_consents`                | Linked to user address, accessed via privacy API |

---

## 7. Administrative Cross-Tenant Access

An administrator may need to access resources across tenant boundaries (e.g.
DLQ replay, platform diagnostics, data export). This is explicitly supported
via the `adminCrossTenant` helper.

### How it works

```typescript
// src/db/repositories/tenantScopedRepository.ts

export async function adminCrossTenant<T>(
  action: string,
  fn: AdminCrossTenantCall<T>,
): Promise<T> {
  const ctx = currentTenantContext();
  if (!ctx)           throw new NoTenantError();
  if (!ctx.isAdmin)   throw new CrossTenantNotGrantedError(action);

  // ← structural audit event emitted BEFORE the call
  recordAuditEvent('ADMIN_CROSS_TENANT_ACCESS', 'admin', action, undefined, {
    action,
    tenantId: ctx.tenantId,
    principal: ctx.principal,
  });

  return fn(ctx.tenantId, ctx.principal);
}
```

### Requirements

- The caller must have an **admin tenant context** (`isAdmin = true`).
- `adminCrossTenant` is the **only** approved path for crossing tenant
  boundaries programmatically.
- Every invocation emits an `ADMIN_CROSS_TENANT_ACCESS` audit event.

### Authorization

Admin access is granted by:

1. Static `ADMIN_API_KEY` bearer token (compared timing-safely in
   `src/middleware/adminAuth.ts`).
2. JWT with `role = "admin"` or `role = "data-protection-officer"`.

Any other principal receives `403 Forbidden`.

### Audit event

```
action:    ADMIN_CROSS_TENANT_ACCESS
resourceType: admin
resourceId: <action name, e.g. "admin.listAllStreams">
meta: {
  action: "admin.listAllStreams",
  tenantId: "GADMINADDR...",
  principal: "jwt:GADMINADDR..."
}
```

The event is written to the in-memory audit log (mirrored to the
`audit_log` Postgres table when `recordAuditEventToDb` is used).  Queries
against `GET /api/audit` expose these events to authorized administrators.

---

## 8. Expected Failure Behavior

| Scenario                                     | Response                       | Notes                                              |
|----------------------------------------------|--------------------------------|----------------------------------------------------|
| No JWT / API key                             | `401 UNAUTHORIZED`             | `requireScope` rejects before any query            |
| Invalid / expired JWT                        | `401 UNAUTHORIZED`             | `authenticate` middleware                          |
| Scoped user queries another tenant's sender  | `403 FORBIDDEN`                | `enforceStreamScope` route guard                   |
| Scoped user fetches another tenant's stream  | `404 NOT_FOUND`                | `getForTenant` returns undefined; existence hidden |
| Repository called without tenant context     | `NoTenantError` (500 if unhandled) | `currentTenantContext()` returns null            |
| Non-admin calls `adminCrossTenant`           | `CrossTenantNotGrantedError`   | isAdmin check in `adminCrossTenant`                |
| Admin API key not configured                 | `503 SERVICE_UNAVAILABLE`      | `requireAdminAuth` fail-closed                     |

> **Why 404 instead of 403 for stream lookups?**
> Returning 404 for a cross-tenant stream GET prevents an attacker from
> inferring the existence of resources belonging to other tenants.  This
> "404-as-not-found" pattern is intentional and must be preserved.

---

## 9. Validation

The isolation behavior is verified by:

- **`tests/tenant-isolation.test.ts`** — primary isolation test suite (issue #1557):
  - Tenant A cannot list Tenant B's streams.
  - Tenant A receives 403 when it filters by Tenant B's address.
  - Tenant A receives 404 (or undefined at repository layer) for Tenant B's stream ID.
  - `NoTenantError` is thrown when no context is set.
  - `adminCrossTenant` emits the expected `ADMIN_CROSS_TENANT_ACCESS` audit event.
  - Non-admin principals cannot invoke `adminCrossTenant`.

- **`tests/security/streamRepository.sqli.test.ts`** — SQL injection prevention.
- **`tests/routes/admin/tenantRateLimitOverrides.test.ts`** — admin route auth.
- **`tests/routes/admin.apiKeys.test.ts`** — admin API key tenant isolation.

---

## 10. References

- `src/db/repositories/tenantScopedRepository.ts` — structural gate
- `src/db/repositories/streamRepository.ts` — per-record isolation helpers
- `src/middleware/auth.ts` — JWT authentication and tenant identity extraction
- `src/middleware/adminAuth.ts` — admin authorization
- `src/lib/auditLog.ts` — audit event types and writers
- `src/routes/streams.ts` — `enforceStreamScope` middleware
- GitHub issue #1557
