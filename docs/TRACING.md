# Distributed Tracing Hooks (OpenTelemetry optional)

## Overview

Fluxora Backend implements an optional, hook-based distributed tracing system that enables observability without requiring a specific tracing backend. The system is designed to be:

- **Optional**: Can be disabled entirely at runtime with zero overhead (default: disabled)
- **Pluggable**: Supports custom hook implementations (e.g., OpenTelemetry, Jaeger, Datadog)
- **Failure-safe**: Tracing errors never impact application logic
- **PII-aware**: Integrates with existing PII sanitization policies
- **Efficient**: Low per-request overhead when enabled

## Service-Level Outcomes

### What Tracing Provides

The tracing system tracks:

1. **Request Lifecycle** — HTTP request start, response status, and duration
2. **Authentication Events** — Successful auth, failures, and scope information
3. **Database Operations** — Query execution, latency, and errors
4. **External API Calls** — Stellar RPC/Horizon requests, status codes, latency
5. **Stream State Transitions** — Status changes and audit context
6. **Error Classifications** — Categorized errors (database, auth, api, validation, unknown)

### Observable Guarantees

- **Request correlation**: Every request is linked to a unique correlation ID from X-Correlation-ID header
- **User identity**: Authenticated users are logged in PII-safe format (user:xxxx or apikey:xxxx)
- **Latency tracking**: Duration of HTTP requests and sub-operations measured in milliseconds
- **Error context**: Errors include relevant context (path, method, operation) without leaking sensitive data
- **Span buffering**: Recent spans are kept in memory for debugging and metrics aggregation

## Trust Boundaries

### Public Internet Clients

**What they can do:**
- Make unauthenticated requests to public endpoints (e.g., `/health`)
- No tracing data is exposed in responses

**What they cannot do:**
- Access trace data
- Modify tracing configuration
- Influence sampling rate

**Mitigations:**
- Correlation ID is read from request headers but never echoed in responses
- User identity is not exposed in HTTP response bodies
- Sensitive operation details are logged only internally

### Authenticated Partners (API Clients)

**What they can do:**
- Make authenticated requests using API keys or JWT tokens
- Receive opaque trace context in X-Correlation-ID header
- Cannot see internal span details

**What they cannot do:**
- Access internal tracing logs
- Modify tracing behavior
- Retrieve historical span data

**Mitigations:**
- API key identity is sanitized (first 8 chars or hash format)
- User identity linked to spans is not exposed in responses
- Tracing queries require administrative credentials

### Administrators

**What they can do:**
- Enable/disable tracing via TRACING_ENABLED environment variable
- Configure sampling rate (TRACING_SAMPLE_RATE)
- Configure OpenTelemetry integration (TRACING_OTEL_ENABLED)
- Access span buffers and metrics via internal APIs
- Configure hook handlers for custom observability backends

**What they cannot do:**
- Enable tracing at request-level granularity (only operator-level)
- Export traces without configuring a backend

**Equipment needed:**
- Access to environment variables or configuration system
- Access to internal metrics endpoints

### Internal Workers (Indexer, Webhook Service)

**What they can do:**
- Emit span events within their subsystem
- Record errors with context
- Access trace context from request-scoped state

**What they cannot do:**
- Modify global tracer configuration
- Access other workers' trace data
- Bypass error sanitization

**Examples:**
- Indexer records stream state transitions
- Webhook service records delivery attempts
- Database layer records query latency

## Failure Modes and Client-Visible Behavior

### Mode 1: Tracing Disabled (Default)

**Condition:** `TRACING_ENABLED=false` or not set

**Behavior:**
- All tracer API calls are no-ops with zero overhead
- Request processing is unaffected
- No trace context is attached to requests
- Responses remain identical

**Client impact:** None

**Recovery:** None needed

### Mode 2: Span Buffer Full

**Condition:** In-memory buffer exceeds configured maximum (default: 1000 spans)

**Behavior:**
- Oldest spans are dropped from the buffer
- New spans are added normally
- Application continues serving requests
- Warning logged to stderr

**Client impact:** None. HTTP responses unaffected.

**Operator recovery:**
- Increase `--max-spans` configuration if available
- Configure a persistent backend (e.g., OpenTelemetry collector)
- Monitor buffer metrics in logs

### Mode 3: Hook Handler Error

**Condition:** Custom tracer hook throws an exception

**Behavior:**
- Error is caught and logged to stderr
- Application request continues processing
- Tracing data may be incomplete
- Never propagates to abort the request

**Client impact:** None. HTTP responses unaffected.

**Operator recovery:**
- Check logs for tracer hook error details
- Review hook handler implementation
- Disable offending hook if necessary

### Mode 4: OpenTelemetry Misconfiguration

**Condition:** OpenTelemetry TracerProvider is not available or misconfigured

**Behavior:**
- Tracer falls back to built-in hooks
- OTel export is skipped silently
- Application continues serving requests
- Hook-based tracing still works

**Client impact:** None. HTTP responses unaffected.

**Operator recovery:**
- Verify OpenTelemetry has been properly initialized
- Check OTel provider configuration
- Disable TRACING_OTEL_ENABLED if OTel is not available

### Mode 5: Missing Correlation ID

**Condition:** Request arrives without `X-Correlation-ID` header

**Behavior:**
- correlationId middleware generates a default ID (uuid or fallback)
- Tracing uses the fallback ID
- Traces are still captured and linked

**Client impact:** None. Request processing continues.

**Design note:** Tracing never fails due to missing correlation ID.

### Mode 6: Auth Context Not Available

**Condition:** Unauthenticated request to protected endpoint (handled by auth middleware)

**Behavior:**
- No user identity is attached to span (userId = undefined)
- Tracing still captures request metadata
- HTTP response reflects auth error as configured by auth middleware

**Client impact:** Determined by authentication middleware, not tracing.

### Mode 7: Request Aborted or Connection Closed

**Condition:** Client closes connection mid-request

**Behavior:**
- Span is finalized with status='error' and statusMessage='Request aborted'
- onSpanEnd hook is invoked
- No error propagates to other requests

**Client impact:** None on other requests.

## Operator Observability and Incident Diagnosis

### Enabling Tracing

```bash
# Enable tracing with built-in buffering
export TRACING_ENABLED=true

# Reduce overhead: sample 10% of requests
export TRACING_SAMPLE_RATE=0.1

# Enable structured logging of trace events
export TRACING_LOG_EVENTS=true
export LOG_LEVEL=debug

# (Optional) Enable OpenTelemetry export
export TRACING_OTEL_ENABLED=true
```

### Observing Span Events

When `TRACING_LOG_EVENTS=true`, each span event emits a structured JSON log:

```json
{
  "level": "debug",
  "message": "[tracing] span.start",
  "timestamp": "2024-03-30T10:30:45.123Z",
  "traceId": "req-abc-123",
  "spanId": "1",
  "userId": "user:abc...",
  "tags": "{\"http.method\":\"GET\",\"http.path\":\"/api/streams\"}"
}
```

```json
{
  "level": "debug",
  "message": "[tracing] event.db.query",
  "timestamp": "2024-03-30T10:30:45.200Z",
  "traceId": "req-abc-123",
  "spanId": "1",
  "durationMs": 50
}
```

### Querying Span Metrics

The built-in `SpanBuffer` provides real-time metrics:

```typescript
// In operator dashboard or health check endpoint
const buffer = /* obtain SpanBuffer instance */;
const metrics = buffer.getMetrics();
// {
//   totalSpans: 1234,
//   okSpans: 1200,
//   errorSpans: 34,
//   avgDurationMs: 125,
//   maxDurationMs: 5000,
//   minDurationMs: 10
// }
```

### Span Filtering

Examples of filtering for diagnosis:

```typescript
// Get all spans for a specific trace
const traceSpans = buffer.getSpansByTrace('req-abc-123');

// Get recently completed spans (last 60 seconds)
const recent = buffer.getRecentSpans(60000);

// Find error spans
const errors = buffer.getSpans()
  .filter(s => s.status === 'error');
```

### Common Diagnostic Scenarios

#### Slow Requests

1. Check span duration in logs
2. Look for database query events with high durationMs
3. Check for external API calls (api.call events) with high latency
4. Identify bottleneck in event sequence

#### High Error Rate

1. Enable TRACING_LOG_EVENTS=true
2. Filter for error.recorded events
3. Check Error Classifier output: [category, subcategory]
4. Group by error category to identify patterns

#### Authentication Failures

1. Look for auth.failure events in span
2. Check if userId is present or undefined
3. Determine if failure is due to invalid token or missing credentials
4. Check for rate limiting in outer auth middleware

#### Database Issues

1. Filter for db.* events
2. Check durationMs to identify slow queries
3. Look for [database, timeout] or [database, connection] errors
4. Correlate with database pool metrics if available

#### Stellar RPC/Horizon Problems

1. Look for api.call events with endpoint info
2. Check statusCode and durationMs
3. Look for [api, timeout] or [api, not_found] errors
4. Correlate with Stellar service status

### Metrics Collection

The `MetricsCollector` built-in hook tracks:

```typescript
{
  requestsStarted: number;
  requestsCompleted: number;
  requestsErrored: number;
  totalDurationMs: number;
  dbQueriesExecuted: number;
  apiCallsMade: number;
  authFailures: number;
}
```

Export these to a time-series database (Prometheus, CloudWatch) for alerting.

## Verification Steps

### Unit Tests

All tracing functionality is covered by tests in `/tests/tracing/`:

```bash
# Run tracing-specific tests
pnpm test tests/tracing/

# Expected output:
# - Distributed Tracing Hooks (100+ tests)
# - Tracing Middleware (60+ tests)
# - Coverage: >95% on tracing modules
```

### Integration Test: Enable Tracing

1. Set `TRACING_ENABLED=true` in `.env` or environment
2. Restart the application
3. Make a request: `curl http://localhost:3000/api/streams`
4. Verify no errors in application logs
5. Verify span events in console output (if LOG_LEVEL=debug)

### Integration Test: Sampling

1. Set `TRACING_ENABLED=true` and `TRACING_SAMPLE_RATE=0.5`
2. Make 100 requests
3. Verify approximately 50% emit span.start events (statistically)

### Integration Test: Error Handling

1. Make a request to a protected endpoint without auth
2. Verify error is properly classified (auth.failure)
3. Verify no exception is thrown in tracer

### Integration Test: OpenTelemetry (Optional)

1. Set `TRACING_ENABLED=true` and `TRACING_OTEL_ENABLED=true`
2. Provide a mock OTel TracerProvider
3. Verify OTel span methods are called
4. Verify graceful fallback if OTel is unavailable

### Performance Baseline (No Overhead When Disabled)

```bash
# Benchmark with tracing disabled (default)
TRACING_ENABLED=false pnpm test -- --benchmark

# Benchmark with tracing enabled
TRACING_ENABLED=true pnpm test -- --benchmark

# Expected: < 5% latency increase on requests when enabled
```

## Non-Goals and Intentional Deferred Work

### Non-Goals (Out of Scope for This Issue)

1. **Real-time streaming to external backends** — OpenTelemetry integration is provided, but external backend setup is operator responsibility
2. **Request sampling at middleware level** — Sampling is implemented at tracer invocation level; per-route sampling is deferred
3. **Distributed context baggage** — Span context is request-scoped; cross-request baggage (e.g., tenant ID) is not carried
4. **Span filtering/mutation** — All events matching a name are recorded; filtering to reduce overhead is operator responsibility
5. **PII classification** — Operators must avoid logging sensitive fields in attributes; no automatic PII detection

### Follow-Up Work (Documented for Future Sprints)

1. **Automatic instrumentation** — Instrument database driver, HTTP client, message queues without explicit calls
   - Rationale: Reduces boilerplate, improves consistency

2. ~~**W3C Traceparent support**~~ — **IMPLEMENTED** (issue #756). See the W3C Trace Context section below.

3. **Sampling strategies** — Implement head-based sampling (consistent trace decision), tail-based sampling, and per-route overrides
   - Rationale: Reduce volume of traces in production while capturing interesting requests

4. **Span export batch optimization** — Batch spans for more efficient export to backends
   - Rationale: Reduce network calls and improve throughput to external collectors

5. **Metrics dashboard** — Create Grafana/CloudWatch dashboard for span metrics
   - Rationale: Operational visibility without log parsing

6. **Trace query API** — Add `/admin/traces` endpoint for operators to query spans
   - Rationale: Avoid log parsing for debugging; real-time query capability

---

## W3C Trace Context Propagation (issue #756)

Fluxora now implements [W3C Trace Context Level 1](https://www.w3.org/TR/trace-context/)
for distributed tracing across service boundaries. This enables continuous traces
from upstream callers through Fluxora to Stellar RPC and webhook consumers.

### Overview

```
upstream caller
    │  traceparent: 00-<traceId>-<parentId>-01
    ▼
tracingMiddleware (src/tracing/middleware.ts)
    │  parses traceparent, adopts upstream traceId
    │  stores TraceparentFields in AsyncLocalStorage
    ▼
route handler / business logic
    │
    ├─► StellarRpcService.accountExists (Horizon fetch)
    │       outbound traceparent: 00-<traceId>-<parentId>-01
    │
    └─► WebhookDispatcher.sendRequest / dispatchWebhook
            outbound traceparent: 00-<traceId>-<parentId>-01
```

### Inbound Parsing (src/tracing/middleware.ts)

The `tracingMiddleware` reads the `traceparent` HTTP header on every inbound
request and validates it with `parseTraceparent()`:

- **Valid header** → upstream `traceId` is used as the span's `traceId`, upstream
  `parentId` is stored as `parentSpanId`, and the `TraceparentFields` object is
  placed in `traceContextStore` (an `AsyncLocalStorage`) for outbound propagation.
- **Invalid / missing header** → existing behaviour is preserved: the local
  correlation ID (`x-correlation-id`) is used as the `traceId` and
  `traceContextStore` stores `null`.

**Security hardening on `parseTraceparent()`:**

| Check | What it prevents |
|-------|-----------------|
| Length cap (200 chars) before regex | ReDoS on pathological inputs |
| Anchored regex (`^…$`) | Partial / prefix matching |
| Reserved version `ff` rejected | Forward-compat guard per spec |
| All-zero `traceId` rejected | Invalid per spec §2.2.4 |
| All-zero `parentId` rejected | Invalid per spec §2.2.5 |
| Lower-cased before comparison | Case-insensitive, canonical output |

### Outbound Propagation

#### Stellar RPC (src/services/stellar-rpc.ts)

`StellarRpcService.accountExists()` calls `getActiveTraceContext()` before
each Horizon HTTP fetch. When a non-null context is available, `buildTraceparent()`
constructs the header and it is added to the request:

```
traceparent: 00-<upstream-traceId>-<upstream-parentId>-<flags>
```

No header is added when `getActiveTraceContext()` returns `null` (no upstream trace).

#### Webhook Dispatcher (src/webhooks/dispatcher.ts)

Both `WebhookDispatcher.sendRequest()` (class-based) and `dispatchWebhook()`
(convenience function) call `getActiveTraceContext()` and attach a `traceparent`
header when a trace context is present. Correlation ID propagation via
`x-correlation-id` is unchanged.

### API

```typescript
// Parse an inbound traceparent header (returns null on any invalid input)
import { parseTraceparent } from './src/tracing/middleware.js';
const fields = parseTraceparent(req.headers['traceparent']);
// → { version, traceId, parentId, flags, sampled } | null

// Build an outbound traceparent header
import { buildTraceparent } from './src/tracing/middleware.js';
const header = buildTraceparent(traceId, parentId, sampled);
// → "00-<traceId>-<parentId>-01"

// Read the active trace context (works anywhere in the async call chain)
import { getActiveTraceContext } from './src/tracing/middleware.js';
const ctx = getActiveTraceContext();
// → TraceparentFields | null
```

### Backward Compatibility

- Clients that do not send `traceparent` continue to work exactly as before.
- The correlation-ID header (`x-correlation-id`) continues to function.
- When both are present, `traceparent` takes precedence for trace continuity;
  the correlation ID is still propagated independently.
- No new required environment variables; the feature works automatically once
  `tracingMiddleware` is in the middleware stack.

## Configuration Reference

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `TRACING_ENABLED` | boolean | `false` | Enable distributed tracing |
| `TRACING_SAMPLE_RATE` | float (0.0-1.0) | `1.0` | Fraction of requests to trace (100% if enabled) |
| `TRACING_OTEL_ENABLED` | boolean | `false` | Enable OpenTelemetry export |
| `TRACING_LOG_EVENTS` | boolean | `false` | Log span events to stdout/stderr |

### Code Configuration

```typescript
// app.ts or index.ts
import { initializeTracer, createBuiltInHooks } from './tracing/hooks.js';
import { tracingMiddleware } from './tracing/middleware.js';

// Initialize tracer with built-in hooks
const tracer = initializeTracer({
  enabled: config.tracingEnabled,
  sampleRate: config.tracingSampleRate,
  hooks: createBuiltInHooks({
    enableBuffer: true,
    enableMetrics: true,
    bufferConfig: {
      maxSpans: 1000,
      logEvents: config.tracingLogEvents,
    },
  }),
  otel: {
    enabled: config.tracingOtelEnabled,
    tracerProvider: customTracerProvider, // or undefined to skip
  },
});

// Add tracing middleware (early in the stack)
app.use(tracingMiddleware({
  enabled: config.tracingEnabled,
  sampleRate: config.tracingSampleRate,
}));
```

## Code References

- Tracer core: [src/tracing/hooks.ts](../src/tracing/hooks.ts)
- Middleware integration: [src/tracing/middleware.ts](../src/tracing/middleware.ts)
- Built-in hooks: [src/tracing/builtin.ts](../src/tracing/builtin.ts)
- Tests: [tests/tracing/](../tests/tracing/)

---

## Instrumented Spans

The following spans are emitted automatically when tracing is enabled.

### HTTP — `http.response` event on every request span

| Tag | Value |
|-----|-------|
| `http.method` | `GET`, `POST`, etc. |
| `http.path` | Request path |
| `http.ip` | Client IP |
| `http.user_agent` | User-Agent header |
| `statusCode` | HTTP response status |
| `durationMs` | Total request duration |

Span status is `ok` for `< 400`, `error` otherwise.

### Database — `db.query`

Emitted by `src/db/pool.ts` for every `query()` call.

| Tag | Value |
|-----|-------|
| `span.name` | `db.query` |
| `db.sql` | SQL statement |
| `correlationId` | Propagated from request context |

Span status is `error` if the query throws (including `DuplicateEntryError`).

### Stellar RPC — `stellar.rpc`

Emitted by `src/services/stellar-rpc.ts` for every RPC call.

| Tag | Value |
|-----|-------|
| `span.name` | `stellar.rpc` |
| `rpc.operation` | e.g. `getLatestLedger` |
| `correlationId` | Propagated from request context |

Span status is `error` if the circuit breaker trips or the call times out.

### Webhook Dispatch — `webhook.dispatch`

Emitted by `src/webhooks/dispatcher.ts` for every `dispatchWebhook()` call.

| Tag | Value |
|-----|-------|
| `span.name` | `webhook.dispatch` |
| `webhook.event` | Event name (e.g. `stream.created`) |
| `webhook.url` | Destination URL |
| `webhook.retry` | Retry attempt number (0 = first attempt) |
| `correlationId` | Propagated from request context |

Span status is `error` if all retries are exhausted and the final attempt throws.

### WebSocket Broadcast — `ws.broadcast`

Emitted by `src/ws/hub.ts` for every `broadcast()` call that delivers at least one message.

| Attribute | Value |
|-----------|-------|
| `ws.stream_id` | Stream being broadcast |
| `ws.event_id` | Unique event identifier |
| `ws.recipients` | Number of clients that received the message |

This span uses `eventId` as its `traceId` because broadcasts happen outside an HTTP request context.

---

## correlationId Propagation Through Async Boundaries

`src/tracing/middleware.ts` uses Node's `AsyncLocalStorage` to propagate the
`correlationId` through all async continuations spawned within a request:

```typescript
import { getCorrelationId } from './tracing/middleware.js';

// Inside any async function called during a request:
const correlationId = getCorrelationId(); // returns the request's correlationId
```

This means DB queries, RPC calls, and webhook dispatches triggered by the same
HTTP request all share the same `correlationId` in their spans — even across
`await` boundaries, `setTimeout`, and `Promise.all`.

Furthermore, `src/lib/logger.ts` automatically retrieves the `correlationId` 
from the `AsyncLocalStorage` context if one is not explicitly provided. This 
ensures that all log lines—including DB query logs and indexer-triggered 
background work—will implicitly carry the `correlationId` if they occur 
within the async context of the triggering request.

When called outside a request context (e.g., background jobs), `getCorrelationId()`
returns `'unknown'`.

### `traceSpan` helper

```typescript
import { traceSpan } from './tracing/hooks.js';

const result = await traceSpan(
  'my.operation',          // span name
  correlationId,           // trace ID
  { 'my.tag': 'value' },  // additional tags
  async (span) => {
    // span is available if you need to record extra events
    return doWork();
  },
);
```

The helper starts a span, runs the async function, ends the span `ok` on
success or `error` on throw, and always re-throws the original error.


---

## Sampling Strategies

Fluxora supports four trace sampling strategies to control observability cost
and signal-to-noise ratio in production:

1. **Head-based sampling** (recommended for production)
2. **Tail-based sampling** (error-focused)
3. **Always** (useful for development / debugging)
4. **Never** (useful for benchmarking overhead)

### Head-based sampling (default)

The sampling decision is made **at trace creation time** using a deterministic
FNV-1a hash of the trace ID. Because the decision is derived from the trace ID
itself, all services/replicas that see the same trace ID make the same
keep-or-drop decision, guaranteeing that you never get partial traces.

**Algorithm:**
```
bucket = FNV-1a32(traceId) % 1000
keep   = bucket < round(sampleRate * 1000)
```

**Properties:**
- Pure function: same trace ID → same decision, always, on every replica.
- No shared state required.
- Uniform distribution: 50% sample rate yields ~50% of traces kept.

**Configuration:**

| Env Var | Type | Default | Description |
|---------|------|---------|-------------|
| `TRACING_SAMPLING_STRATEGY` | `'head'` | `'head'` | Enable head-based sampling |
| `TRACING_HEAD_SAMPLE_RATE` | float 0–1 | value of `TRACING_SAMPLE_RATE` | Fraction of traces to keep |
| `TRACING_PER_ROUTE_OVERRIDES` | JSON string | unset | Route-specific sample rates (see below) |

**Example:**
```bash
export TRACING_SAMPLING_STRATEGY=head
export TRACING_HEAD_SAMPLE_RATE=0.1       # keep 10% of traces globally
export TRACING_PER_ROUTE_OVERRIDES='{ "/health": 0, "/api/streams": 1 }'
# Health checks: never sampled (0%)
# Stream API: always sampled (100%)
# Everything else: 10%
```

### Per-route overrides

When using head-based sampling, individual API routes can have their own
sample rates configured via `TRACING_PER_ROUTE_OVERRIDES`:

```json
{
  "/health": 0,
  "/metrics": 0,
  "/api/streams": 1,
  "/api": 0.25
}
```

**Lookup rules:**
1. Exact match checked first (`/api/streams` matches `/api/streams` exactly).
2. Longest prefix match (`/api/streams/abc` matches `/api/streams` with rate 1.0, not `/api` with 0.25).
3. If no match, use global `TRACING_HEAD_SAMPLE_RATE`.

### Tail-based sampling

The decision is made **at span-end time** based on the span's outcome. Error
spans (status `'error'` or events named `'error'`) are always kept when
`TRACING_TAIL_KEEP_ERRORS=true`, without requiring full in-memory buffering.

**Configuration:**

| Env Var | Type | Default | Description |
|---------|------|---------|-------------|
| `TRACING_SAMPLING_STRATEGY` | `'tail'` | `'head'` | Enable tail-based sampling |
| `TRACING_HEAD_SAMPLE_RATE` | float 0–1 | 1.0 | Sample rate for non-error spans |
| `TRACING_TAIL_KEEP_ERRORS` | boolean | `true` | Always keep spans with errors |

**Example:**
```bash
export TRACING_SAMPLING_STRATEGY=tail
export TRACING_HEAD_SAMPLE_RATE=0.01      # 1% of healthy traffic
export TRACING_TAIL_KEEP_ERRORS=true      # but 100% of errors
```

**Use case:** Debugging production incidents. You capture every error trace
while sampling only a small fraction of healthy traffic to keep costs low.

**Limitation:** Unlike head-based sampling, tail sampling does NOT guarantee
full cross-service trace consistency — if service A drops a trace and service B
keeps it (due to an error), you may see partial traces. For this reason,
head-based sampling is recommended for production.

### Always / Never

**Always** (`TRACING_SAMPLING_STRATEGY=always`):
- Keeps every span.
- Useful for local development and debugging specific issues.
- **Not recommended for production** — high cost, high cardinality.

**Never** (`TRACING_SAMPLING_STRATEGY=never`):
- Drops every span.
- Useful for benchmarking the overhead of the tracing instrumentation itself.

---

## Implementation Notes

### Determinism

Head-based sampling uses a pure FNV-1a 32-bit hash function:
- Offset basis: `2166136261`
- Prime: `16777619`
- No external dependencies; implemented in `src/tracing/hooks.ts`.

The same trace ID produces the same bucket on every call, on every replica,
with no clock drift, no shared state, and no race conditions.

### Migration from flat `TRACING_SAMPLE_RATE`

The legacy `TRACING_SAMPLE_RATE` env var (flat probability applied per span)
is still respected for backward compatibility:
- When `TRACING_SAMPLING_STRATEGY` is unset or `'head'`, and
  `TRACING_HEAD_SAMPLE_RATE` is also unset, the global rate defaults to
  `TRACING_SAMPLE_RATE`.
- This preserves existing behavior: old configs continue to work without changes.

### Testing

See `tests/tracing/sampling.test.ts` for comprehensive coverage:
- `shouldSampleHead` determinism and distribution (50% rate → 35%–65% kept)
- `shouldSampleTail` error retention and random sampling
- `resolvePerRouteOverride` exact match, prefix match, fallback
- `getSamplingConfig` env var parsing for all strategies
