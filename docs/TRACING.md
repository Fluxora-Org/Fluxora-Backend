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
2. **Automatic span propagation across services** — Correlation ID is used locally; W3C traceparent headers not implemented in this version
3. **Request sampling at middleware level** — Sampling is implemented at tracer invocation level; per-route sampling is deferred
4. **Distributed context baggage** — Span context is request-scoped; cross-request baggage (e.g., tenant ID) is not carried
5. **Span filtering/mutation** — All events matching a name are recorded; filtering to reduce overhead is operator responsibility
6. **PII classification** — Operators must avoid logging sensitive fields in attributes; no automatic PII detection

### Follow-Up Work (Documented for Future Sprints)

1. **Automatic instrumentation** — Instrument database driver, HTTP client, message queues without explicit calls
   - Ticket: [Create issue for auto-instrumentation]
   - Rationale: Reduces boilerplate, improves consistency

2. **W3C Traceparent support** — Implement W3C Trace Context for cross-service propagation
   - Ticket: [Create issue for W3C traceparent]
   - Rationale: Enables end-to-end tracing across Fluxora services and external APIs
   - Depends on: OpenTelemetry integration validation

3. **Sampling strategies** — Implement head-based sampling (consistent trace decision), tail-based sampling, and per-route overrides
   - Ticket: [Create issue for advanced sampling]
   - Rationale: Reduce volume of traces in production while capturing interesting requests

4. **Span export batch optimization** — Batch spans for more efficient export to backends
   - Ticket: [Create issue for batch export]
   - Rationale: Reduce network calls and improve throughput to external collectors

5. **Metrics dashboard** — Create Grafana/CloudWatch dashboard for span metrics
   - Ticket: [Create issue for metrics dashboard]
   - Rationale: Operational visibility without log parsing

6. **Trace query API** — Add `/admin/traces` endpoint for operators to query spans
   - Ticket: [Create issue for trace query API]
   - Rationale: Avoid log parsing for debugging; real-time query capability

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
