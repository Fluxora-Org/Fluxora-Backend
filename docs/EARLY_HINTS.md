# HTTP 103 Early Hints & Safe Degradation

## Overview

HTTP 103 Early Hints ([RFC 8297](https://datatracker.ietf.org/doc/html/rfc8297)) allow the server to emit preliminary informational responses containing `Link` headers (such as `rel="next"` and `rel="prev"` pagination links) while the primary payload is still being fetched or computed.

Because Early Hints are an optimization, any behavior that degrades or breaks non-supporting clients or intermediaries is unacceptable. The implementation follows strict fail-safe principles.

---

## Client Support Negotiation

Clients must explicitly advertise support for Early Hints before the server will emit a 103 response. Support is detected if any of the following request headers are set to `1` or `true`:

- `Early-Hints: 1`
- `X-Early-Hints: 1`
- `Accept-Early-Hints: 1`

If none of these headers are present, Early Hints are skipped entirely, and the client receives only the standard 200 OK response.

---

## Intermediary & Proxy Resilience

Intermediaries (CDNs, reverse proxies, corporate firewalls) may strip or mishandle 103 informational responses:

1. **Non-blocking Dispatch**: Early Hints are dispatched asynchronously via `setImmediate()`. They never block or delay the main HTTP response stream.
2. **Exception Containment**: Any socket error or write failure encountered when attempting to send informational headers via `res.writeProcessing()` is caught and logged, ensuring the primary response pipeline remains unperturbed.
3. **Identical Payload Invariants**: The JSON body returned to a client with Early Hints is byte-for-byte identical to the payload delivered to a client without Early Hints.

---

## Configuration Toggle

Early Hints can be disabled globally across the service via environment variables:

```bash
# Disable Early Hints
EARLY_HINTS_ENABLED=false
# or
ENABLE_EARLY_HINTS=false
```

When disabled via configuration:
- `isEarlyHintsConfigEnabled()` returns `false`.
- `sendEarlyHints()` immediately exits without writing to the response.
- All endpoints transparently serve standard HTTP responses without informational headers.

---

## Testing & Verification

Comprehensive coverage is split across two test suites:

1. **Dedicated Unit Suite** (`tests/unit/utils/earlyHints.test.ts`):
   - Header negotiation detection (`clientSupportsEarlyHints`)
   - Configuration toggle inspection (`isEarlyHintsConfigEnabled`)
   - Safe degradation when headers are missing, unadvertised, or already sent
   - Socket error handling during `writeProcessing`
2. **Route Integration Suite** (`tests/routes/streams.earlyHints.test.ts`):
   - Live endpoint assertion on `GET /api/streams`
   - Equivalence assertions between supporting and non-supporting requests
   - Config disablement assertion
