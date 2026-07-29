# @fluxora/sdk — TypeScript Client SDK

> **Version**: 0.1.0 · **Generated from** `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
> Do not edit by hand — run `pnpm generate:sdk:ts` to regenerate.

Typed TypeScript client for the [Fluxora Backend API](../../docs/api.md).
Zero external runtime dependencies; uses the standard Web `fetch` API.

---

## Features

| Feature | Detail |
|---------|--------|
| **Zero dependencies** | Uses native `fetch` — works in Node.js ≥ 18, Deno, Bun, and browsers |
| **Full type safety** | Every request/response is typed from `openapi.yaml` |
| **Cursor pagination** | `StreamPaginator` wraps keyset cursors behind an ergonomic async generator |
| **Idempotency** | UUID v4 key generation + canonical SHA-256 body hashing matching the server |
| **Typed error hierarchy** | `FluxoraApiError`, `IdempotencyConflictError`, `ValidationError` |
| **Client-side validation** | Input guards throw `ValidationError` before any network round-trip |
| **Auth support** | Bearer JWT + static API key |
| **Deterministic dispatch** | No hidden retries; query params and JSON bodies are sent in caller insertion order |

---

## Installation

This is an internal workspace package declared in `pnpm-workspace.yaml`.
Reference it from sibling packages with:

```json
{ "dependencies": { "@fluxora/sdk": "workspace:*" } }
```

---

## Quickstart

```typescript
import {
  FluxoraClient,
  generateIdempotencyKey,
  FluxoraApiError,
  IdempotencyConflictError,
} from '@fluxora/sdk';

const client = new FluxoraClient({
  baseUrl: 'http://localhost:3000',
  bearerToken: process.env.FLUXORA_TOKEN,
});

// Health probe
const health = await client.getHealth();
console.log('Status:', health.status); // 'ok' | 'degraded' | 'shutting_down'

// Create a stream (auto-generates Idempotency-Key)
const stream = await client.createStream({
  sender:        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  recipient:     'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
  depositAmount: '1000000.0000000',
  ratePerSecond: '0.0000116',
  startTime:     Math.floor(Date.now() / 1000),
});
console.log('Stream:', stream.id, stream.status);

// Paginate all active streams
const paginator = client.listStreams({ limit: 20, status: 'active' });
for await (const s of paginator.autoPaginate()) {
  console.log(s.id, s.depositAmount);
}
```

---

## Error handling

```typescript
import { FluxoraApiError, IdempotencyConflictError, ValidationError } from '@fluxora/sdk';

try {
  await client.createStream(payload, 'my-idempotency-key');
} catch (err) {
  if (err instanceof IdempotencyConflictError) {
    // Same key, different payload — generate a new key
    console.error('Conflict:', err.storedHash, err.incomingHash);
  } else if (err instanceof FluxoraApiError) {
    console.error(`HTTP ${err.statusCode} [${err.code}]: ${err.message}`);
    // err.requestId — correlate with server logs
  } else if (err instanceof ValidationError) {
    console.error('Bad input:', err.message);
  }
}
```

---

## Idempotency

POST /api/streams requires an `Idempotency-Key` header. The SDK handles this automatically:

- If you omit `idempotencyKey`, the SDK auto-generates a UUID v4.
- The SDK does **not** retry requests internally. If your application retries, supply and reuse the **same key** for every attempt of the same logical create operation.
- Reusing a key with a **different body** throws `IdempotencyConflictError`.
- The helper uses caller-scoped cache keys to avoid cross-tenant collisions and keeps the retry semantics explicit: replayed requests return the cached result, while concurrent requests for the same logical operation fail fast with `CONCURRENT_REQUEST`.
- Observability hooks emit info, warn, and error events for validation, cache hits, lock contention, fresh execution, and operation failures.

```typescript
const key = generateIdempotencyKey(); // UUID v4
const stream = await client.createStream(payload, key);
// On retry:
const same = await client.createStream(payload, key); // replays cached response
```

---

## Security notes

- Bearer tokens and API keys are stored in memory only and never logged.
- The `Authorization` and `X-API-Key` headers are only added when non-empty credentials are present; runtime setters trim surrounding whitespace.
- Client-side input validation rejects obviously invalid values before network dispatch.
- Per-request SDK headers override constructor headers. Runtime credentials override any user-supplied `Authorization` or `X-API-Key` constructor headers.
- TLS certificate validation is performed by the platform's `fetch` implementation.
- Idempotency key values are never echoed in error bodies or logs (server-side guarantee).

---

## SDK Generation Contract

The TypeScript SDK is generated from `openapi.yaml` and its compatibility
surface is intentionally small:

- Public exports remain `types`, `errors`, `idempotency`, `pagination`, and `client`.
- `FluxoraClient` methods preserve the current backend envelopes and unwrap only the documented stream convenience shapes.
- Requests use native `fetch` once per SDK method call. Network failures from `fetch` are allowed to bubble unchanged.
- Query parameters omit only `undefined` and `null` values; `false`, `0`, and empty strings are serialized.
- JSON responses are parsed when possible. Empty successful responses resolve to `{}`; text error bodies become `FluxoraApiError` messages.
- Request IDs are read from `X-Request-ID` first, then response envelope metadata, then nested error objects.
- Generated output must pass `pnpm check:sdk:ts`; drift is treated as a regression.

---

## API Reference

### `new FluxoraClient(config?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | `'http://localhost:3000'` | API base URL |
| `bearerToken` | `string` | — | JWT from `createSession()` |
| `apiKey` | `string` | — | Static API key (`X-API-Key` header) |
| `headers` | `Record<string, string>` | — | Extra headers merged into every request |

### Stream methods

| Method | Description |
|--------|-------------|
| `createStream(input, key?)` | POST /api/streams — auto-generates key if omitted |
| `getStream(id)` | GET /api/streams/:id |
| `listStreams(params?)` | Returns a `StreamPaginator` |
| `cancelStream(id)` | DELETE /api/streams/:id |
| `updateStreamStatus(id, status)` | PATCH /api/streams/:id/status |

### Other methods

| Method | Description |
|--------|-------------|
| `getRoot()` | GET / |
| `getHealth()` | GET /health |
| `getHealthReady()` | GET /health/ready |
| `getHealthLive()` | GET /health/live |
| `createSession(address, role?)` | POST /api/auth/session |
| `getPrivacyPolicy()` | GET /api/privacy/policy |
| `getPrivacyRetention()` | GET /api/privacy/retention |
| `putPrivacyConsent(consent)` | PUT /api/privacy/consent |
| `getPrivacyConsent(address)` | GET /api/privacy/consent/:address |
| `queueWebhook(payload)` | POST /internal/webhooks/queue |
| `getWebhookDelivery(id)` | GET /internal/webhooks/:id |

---

## Pagination

`listStreams()` returns a `StreamPaginator`. Use `autoPaginate()` or `nextPage()`:

```typescript
// Async generator — iterate all streams
for await (const stream of client.listStreams().autoPaginate()) {
  process(stream);
}

// Manual paging
const pager = client.listStreams({ limit: 50, status: 'active' });
let page = await pager.nextPage();
while (page) {
  doSomething(page);
  page = await pager.nextPage();
}
```

Cursors are **opaque base64url tokens** — never construct or decode them.
See [`docs/openapi/README.md`](../../docs/openapi/README.md) for full cursor semantics.

---

## Regenerating the SDK

```bash
pnpm generate:sdk:ts        # regenerate sdk/typescript/
pnpm check:sdk:ts           # CI drift check — exits 1 if files differ
```

The generator reads `openapi.yaml` and overwrites all files under `sdk/typescript/`.
