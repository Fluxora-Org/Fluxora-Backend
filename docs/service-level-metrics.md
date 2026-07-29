# Service-Level Metrics Documentation

## Overview

This document describes the service-level metrics instrumentation in the Stellar Fluxora backend, focusing on the `src/metrics/businessMetrics.ts` module. The metrics system provides observability into key operational aspects including authentication latency, webhook delivery, SSE connections, indexer operations, and database performance.

## Current Implementation Architecture

### Core Metrics Module

The `businessMetrics.ts` module serves as the central hub for business-level metrics, exporting:

- **16+ metric instruments** (Counters, Histograms, Gauges)
- **Helper functions** for validation and safe observation (`safeObserveDuration`, `sanitizeMetricGaugeValue`)
- **Registry integration** with Prometheus
- **Edge-case protection** for robust operation

### Metrics Categories

1. **Authentication Metrics**
   - JWT verification latency (`authJwtVerifyDurationSeconds`)
   - API key lookup latency (`authApiKeyLookupDurationSeconds`)

2. **Webhook Delivery Metrics**
   - Delivery attempts (`webhookDeliveriesTotal`)
   - Delivery duration (`webhookDeliveryDurationSeconds`)
   - Suppressed deliveries (`webhookDeliveriesSuppressedTotal`)
   - DLQ depth (`webhookDlqItemsGauge`)
   - Outbox backlog (`webhookOutboxPendingItemsGauge`)

3. **SSE (Server-Sent Events) Metrics**
   - Active connections (`sseActiveConnectionsGauge`)
   - Connection rejections (`sseConnectionsRejectedTotal`)
   - Live subscribers (`sseLiveSubscribersGauge`)
   - Event listeners (`sseEventListenersGauge`)
   - Subscriber errors (`sseSubscriberErrorsTotal`)
   - Backpressure drops (`sseBackpressureDropsTotal`)

4. **Indexer Metrics**
   - Events ingested (`indexerEventsIngestedTotal`)
   - Ingestion lag (`indexerLagSeconds`)

5. **WebSocket Authentication**
   - Auth failures (`wsAuthFailureTotal`)

6. **Admin Operations**
   - Reindex job duration (`adminReindexJobDurationSeconds`)

## Key Functions and Contracts

### 1. `WebhookMetricsProvider` Interface

**Purpose**: Defines a formal contract for stores providing webhook queue metrics to `syncWebhookMetrics`.

**Signature**:
```typescript
export interface WebhookMetricsProvider {
  getMetrics(): {
    dlqItems?: number;
    outboxItems?: number;
  } | null;
}
```

**Behavior**:
- `getMetrics()` must not throw exceptions.
- It should return `null` or an empty object on failure.

### 2. `syncWebhookMetrics(store?: WebhookMetricsProvider | null)`

**Purpose**: Sync webhook metrics (DLQ depth and outbox backlog) from the store into Prometheus gauges.

**Signature**:
```typescript
export function syncWebhookMetrics(store?: WebhookMetricsProvider | null): void;
```

**Behavior**:

- **Called on every authenticated `/metrics` scrape** to ensure Prometheus sees current queue depth
- **Never throws** - all errors are caught and handled gracefully
- **Fallback to 0** on any store error to prevent 500 responses


**Edge-Case Handling**:

- `undefined` / `null` store → gauges set to `0`
- Missing or non-function `getMetrics` → gauges set to `0`
- `getMetrics()` throws → gauges set to `0` (error swallowed)
- `getMetrics()` returns `null` / `undefined` / partial objects → missing fields sanitized to `0`
- Invalid numeric fields → sanitized via `sanitizeMetricGaugeValue`
- Negative values → clamped to `0`
- Large values → clamped to `Number.MAX_SAFE_INTEGER`

### 3. `sanitizeMetricGaugeValue(val: unknown): number`

**Purpose**: Sanitize store-reported gauge values into non-negative finite integers.

**Edge-Case Contract**:

- Non-numbers (`null`, `undefined`, strings, objects) → `0`
- Non-finite numbers (`NaN`, `±Infinity`) → `0`
- Negatives → `0`
- Fractional values → `Math.floor` (counts are whole deliveries)
- Values above `Number.MAX_SAFE_INTEGER` → clamped to `Number.MAX_SAFE_INTEGER`

### 4. Validation Functions

#### `isValidStreamStatus(value: string): value is StreamStatus`

- **Purpose**: Validate stream status values
- **Accepted values**: `'active'`, `'paused'`, `'completed'`, `'cancelled'`
- **Security**: Prevents invalid status injection

#### `isValidDeliveryOutcome(value: string): value is WebhookDeliveryOutcome`

- **Purpose**: Validate webhook delivery outcome values
- **Accepted values**: `'success'`, `'failed'`
- **Security**: Ensures only valid outcome labels are used

#### `isValidRejectionReason(value: string): value is SseConnectionRejectionReason`

- **Purpose**: Validate SSE connection rejection reasons
- **Accepted values**: `'per_ip_limit'`, `'global_limit'`
- **Security**: Prevents cardinality blowup from arbitrary rejection reasons

### 5. `safeObserveDuration(histogram: Histogram, durationSeconds: number): void`

**Purpose**: Observe duration into histogram with NaN/negative value protection.

**Behavior**:

- **NaN values** → observed as `0`
- **Negative values** → observed as `0`
- **Infinity values** → observed as `0`
- **Valid positive values** → passed through unchanged

### 6. `webhookMetricsSyncTotal` Counter

**Purpose**: Provides observability into the `syncWebhookMetrics` function itself.

**Labels**:
- `outcome: 'success'`: The provider returned valid metrics.
- `outcome: 'success_empty'`: The provider returned `null` or an empty object.
- `outcome: 'provider_unavailable'`: The provider was `null`, `undefined`, or missing `getMetrics`.
- `outcome: 'provider_error'`: The provider's `getMetrics()` method threw an exception.

## Security Considerations

### Label Set Restrictions

All metrics with user-input potential have **strictly bounded label sets**:

1. **Auth Latency Histograms**
   - Only `outcome` label (`'success'` | `'failure'`)
   - No credential-bearing labels (`jti`, `address`, `subject`, `kid`, etc.)

2. **Webhook Metrics**
   - Gauges have **no labels** (empty label set)
   - Counters use only `outcome` (`'success'` | `'failed'`)

3. **SSE Metrics**
   - Error counters use bounded `reason` enum
   - Connection rejection counters use single series (no labels)

### PII Protection

- **No payloads, IPs, or PII** included in any metric labels
- **Fixed enums** prevent cardinality blowup
- **Input validation** ensures only known values are accepted

## Testing Coverage

### Existing Test Suite (`tests/metrics/businessMetrics.test.ts`)

**38 tests covering**:

1. **Webhook Service Metrics** (8 tests)
   - Success/failure outcome recording
   - Network exception handling
   - Latency observation

2. **Webhook DLQ and Outbox Metrics** (26 tests)
   - Store synchronization
   - Edge-case protection (null, undefined, missing functions)
   - Value sanitization (negative, fractional, large values)
   - Regression-locked contracts

3. **Indexer Service Metrics** (2 tests)
   - Ingested count recording
   - Lag gauge updates

4. **Scrape Integration** (2 tests)
   - Business metrics exposure in `/metrics` endpoint
   - Webhook queue gauge synchronization

5. **Security Validation** (1 test)
   - No PII in webhook metric labels

6. **Registry Lifecycle** (1 test)
   - Duplicate registration prevention
   - De-registration support

### Edge-Case Test Coverage

The test suite explicitly validates:

- **Null/undefined handling** for stores and return values
- **Type safety** for primitive vs object returns
- **Array returns** from `getMetrics`
- **String numeric values** (should be sanitized to 0)
- **Boolean values** (should be sanitized to 0)
- **Negative value clamping**
- **Large value clamping**
- **Fractional value flooring**
- **Exception safety** (no throws on errors)

## Current Behavior (Happy Path)

### Normal Webhook Delivery Flow

1. **Webhook Service** calls `attemptDelivery()`
2. **HTTP request** is made to endpoint
3. **Success (2xx)** → `webhookDeliveriesTotal` increments with `outcome: 'success'`
4. **Duration measured** → `webhookDeliveryDurationSeconds` observes duration
5. **Failure (non-2xx)** → `webhookDeliveriesTotal` increments with `outcome: 'failed'`
6. **Network exception** → `webhookDeliveriesTotal` increments with `outcome: 'failed'`

### Metrics Scraping Flow

1. **Authenticated `/metrics` request** with `Bearer <ADMIN_API_KEY>`
2. **`syncWebhookMetrics()`** called with `webhookDeliveryStore`
3. **Store `getMetrics()`** returns current DLQ and outbox counts
4. **Values sanitized** and set to gauges
5. **Prometheus registry** returns all metrics in Prometheus format

## Expected Regression Surface

### High-Risk Changes

1. **Altering `syncWebhookMetrics` signature**
   - **Impact**: Breaks `/metrics` endpoint integration
   - **Risk**: High - affects all authenticated metric scraping

2. **Removing edge-case handling**
   - **Impact**: Store errors could cause 500 responses
   - **Risk**: High - violates observability must-not-fail principle

3. **Changing label sets**
   - **Impact**: Could expose PII or break downstream consumers
   - **Risk**: High - security and compatibility concerns

### Medium-Risk Changes

1. **Modifying sanitization logic**
   - **Impact**: Could allow invalid metric values
   - **Risk**: Medium - affects data quality but not availability

2. **Adding new required parameters**
   - **Impact**: Breaks existing callers
   - **Risk**: Medium - backward compatibility concern

### Low-Risk Changes

1. **Adding new metric instruments**
   - **Impact**: Increases observability but doesn't break existing functionality
   - **Risk**: Low - additive change

2. **Refactoring internal implementation**
   - **Impact**: May affect performance but not behavior
   - **Risk**: Low - as long as contracts are preserved

## Backward Compatibility

### Guaranteed Compatibility

- **All public function signatures remain unchanged**
- **All metric instrument names remain the same**
- **All label sets remain identical**
- **All edge-case behavior preserved**

### Compatibility Considerations

- **Registry behavior**: Duplicate registration protection maintained
- **Test expectations**: All existing tests pass
- **Integration points**: `/metrics` endpoint behavior unchanged
- **Security guarantees**: No new PII exposure

## Recommendations for Future Enhancements

### Immediate Improvements

1. **Add logging** to `syncWebhookMetrics` for debugging store issues
2. **Consider adding metrics** for store operation failures
3. **Document store interface** more formally

### Long-Term Enhancements

1. **Add metric instrumentation** for store operations themselves
2. **Consider async metric collection** to reduce scrape latency
3. **Add health checks** for metric subsystem

## Conclusion

The service-level metrics instrumentation provides robust observability with comprehensive edge-case protection. The current implementation balances operational visibility with system stability, ensuring that metrics collection never becomes a single point of failure. The extensive test coverage and documented contracts provide confidence for future maintenance and enhancements.

The regression surface is well-understood, with clear boundaries between stable contracts and implementation details. Any changes should respect the existing edge-case handling and security guarantees while maintaining backward compatibility.
