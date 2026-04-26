# Upgrade Guide

This document provides migration instructions for every version that introduces breaking changes to the [ABI stability contract](./ABI_STABILITY.md).

---

## Table of Contents

- [How to Read This Guide](#how-to-read-this-guide)
- [Unreleased / `main`](#unreleased--main)
- [v0.1.0 — Initial stable surface](#v010--initial-stable-surface)
- [Checklist for Integrators](#checklist-for-integrators)

---

## How to Read This Guide

Each section covers one version and is structured as:

1. **What changed** — a concise description of the breaking change.
2. **Who is affected** — which integrator type (indexer, wallet, webhook consumer, operator).
3. **Migration steps** — the exact code or configuration change required.
4. **Rollback** — how to revert if the migration causes issues.

If a change is non-breaking it will not appear here. Refer to the [CHANGELOG](../CHANGES_DETAILED.md) for the full list of changes per release.

---

## Unreleased / `main`

No breaking changes pending.

---

## v0.1.0 — Initial stable surface

**Released:** 2026-04-23

This is the first release that defines a stable ABI. There are no migrations from a prior version. All surfaces described in [`docs/ABI_STABILITY.md`](./ABI_STABILITY.md) are stable from this point forward.

### What integrators should do before going to production

#### 1. Pin to `error.code`, not `error.message`

Error messages are human-readable prose and will be reworded without notice. Your error-handling code must branch on `error.code`:

```typescript
// ✅ Correct — stable
if (response.error.code === 'NOT_FOUND') { ... }

// ❌ Wrong — will break on any patch release
if (response.error.message.includes('not found')) { ... }
```

#### 2. Treat amount fields as strings everywhere

All monetary amounts are decimal strings. Never coerce them to `number` before storing or comparing:

```typescript
// ✅ Correct
const rate: string = stream.ratePerSecond; // "0.0000116"

// ❌ Wrong — loses precision for values > 2^53
const rate: number = parseFloat(stream.ratePerSecond);
```

#### 3. Switch on `event.type` for stream events

The `StreamEvent` union is discriminated by the `type` field. Always handle the exhaustive set and include a default branch for forward compatibility:

```typescript
switch (event.type) {
  case 'StreamCreated':   handleCreated(event); break;
  case 'StreamUpdated':   handleUpdated(event); break;
  case 'StreamCancelled': handleCancelled(event); break;
  default:
    // A future minor release may add new event types.
    // Log and ignore rather than throwing.
    console.warn('Unknown stream event type:', (event as any).type);
}
```

#### 4. Switch on `event` for WebSocket messages

```typescript
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  switch (msg.event) {
    case 'stream.created':   ...; break;
    case 'stream.updated':   ...; break;
    case 'stream.cancelled': ...; break;
    case 'service.degraded': ...; break;
    default:
      // Forward-compatible: ignore unknown event names
      break;
  }
});
```

#### 5. Handle new optional response fields gracefully

Non-breaking releases may add new optional fields to response objects. Use optional chaining and do not fail if an unexpected field is present:

```typescript
// ✅ Correct — ignores unknown fields
const { id, sender, recipient, depositAmount, ratePerSecond, status } = stream;

// ❌ Wrong — strict schema validation will reject new optional fields
assert(Object.keys(stream).length === 8);
```

#### 6. Store and forward stream IDs as opaque strings

The stream ID format (`stream-{txHash}-{eventIndex}`) is stable, but treat it as an opaque string in your storage layer. Do not parse the components for business logic — use the dedicated fields (`transactionHash`, `eventIndex`) from the event payload instead.

#### 7. Validate `StreamStatus` with a known-values check

The state machine is stable, but new status values may be added in minor releases. Guard against unknown statuses:

```typescript
const KNOWN_STATUSES = new Set(['active', 'paused', 'completed', 'cancelled']);

function isKnownStatus(s: string): s is StreamStatus {
  return KNOWN_STATUSES.has(s);
}

// Handle unknown status gracefully rather than throwing
if (!isKnownStatus(stream.status)) {
  console.warn('Unrecognised stream status:', stream.status);
}
```

#### 8. Indexer: validate `eventId` uniqueness before submitting

The ingest endpoint rejects batches containing duplicate `eventId` values with `409 CONFLICT`. Deduplicate within each batch before submission:

```typescript
const uniqueEvents = [...new Map(events.map(e => [e.eventId, e])).values()];
```

#### 9. Indexer: handle reorg signals in health

When `GET /health` returns `indexer.reorgDetected === true`, treat all stream state as potentially stale until `reorgDetected` returns to `false`. Do not surface chain-derived data to end users during this window.

#### 10. Webhook consumers: verify signatures before processing

```typescript
import { verifyWebhookSignature } from './src/webhooks/signature.js';

const result = verifyWebhookSignature({
  secret: process.env.FLUXORA_WEBHOOK_SECRET,
  deliveryId: req.header('x-fluxora-delivery-id'),
  timestamp: req.header('x-fluxora-timestamp'),
  signature: req.header('x-fluxora-signature'),
  rawBody,
  isDuplicateDelivery: (id) => seenIds.has(id),
});

if (!result.ok) {
  return res.status(result.status).json({ error: result.code });
}
```

---

## Checklist for Integrators

Use this checklist when upgrading to any new Fluxora version:

- [ ] Read the relevant section of this guide for the target version.
- [ ] Check [`docs/ABI_STABILITY.md`](./ABI_STABILITY.md) for any surfaces marked `⚠️ DEPRECATED`.
- [ ] Search your codebase for any use of `error.message` in conditional logic — replace with `error.code`.
- [ ] Search your codebase for `parseFloat` or `Number()` applied to amount fields — replace with string handling.
- [ ] Confirm your `StreamEvent` switch statement has a `default` branch.
- [ ] Confirm your WebSocket message handler has a `default` branch.
- [ ] Confirm your `StreamStatus` handling is forward-compatible with unknown values.
- [ ] Run your integration test suite against the new version before promoting to production.
- [ ] If you maintain a local copy of the OpenAPI spec, regenerate your client from `openapi.yaml`.

---

*For the full list of stable surfaces and what counts as a breaking change, see [`docs/ABI_STABILITY.md`](./ABI_STABILITY.md).*
