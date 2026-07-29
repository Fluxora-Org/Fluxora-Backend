# Environment Reload Behavior Documentation

## Overview
Fluxora-Backend supports runtime configuration reload via the SIGHUP signal. When the process receives SIGHUP, it reloads a subset of environment variables without requiring a full restart. This document details the current behavior, edge cases, and regression surface.

**Version**: Based on implementation in `src/config/env.ts` (commit reference: current)

## Core Components

### `reloadHotConfig(): HotConfig`
The primary function that reads current `process.env` values and returns a frozen `HotConfig` object.

**Behavior:**
- Reads only whitelisted hot-reloadable keys
- Returns a frozen object (immutable)
- Detects changes to restart-only keys and logs warnings
- Automatically captures startup snapshot if not already captured

### `captureStartupEnvSnapshot(): void`
Captures initial values of restart-only environment variables at startup.

**Behavior:**
- Called once during startup (or implicitly on first `reloadHotConfig()` call)
- Subsequent calls are no-ops (idempotent)
- Stores values in a frozen object

### `reloadFlags(): ReadonlyMap<string, FeatureFlagDefinition>`
Reloads feature flags from `FEATURE_FLAGS_JSON` or `FEATURE_FLAGS_FILE`.

**Behavior:**
- Parses JSON from env var or file
- Invalid entries are skipped (does not crash)
- Atomic replacement of flag map

### `setRuntimeRateLimitConfig(patch): RuntimeRateLimitConfig`
Applies hot-reloaded rate limit configuration to runtime store.

**Behavior:**
- Merges partial updates into existing runtime config
- Falls back to defaults if no runtime config exists
- Used by SIGHUP handler to apply new rate limits

## Hot-Reloadable Keys

| Environment Variable | Type | Default | Description |
|----------------------|------|---------|-------------|
| `RATE_LIMIT_IP_WINDOW_MS` | number (ms) | undefined (uses default 60000) | IP-based rate limit window |
| `RATE_LIMIT_IP_MAX` | number | undefined (uses default 100) | Max IP requests per window |
| `RATE_LIMIT_APIKEY_WINDOW_MS` | number (ms) | undefined (uses default 60000) | API key rate limit window |
| `RATE_LIMIT_APIKEY_MAX` | number | undefined (uses default 500) | Max API key requests per window |
| `RATE_LIMIT_ADMIN_WINDOW_MS` | number (ms) | undefined (uses default 60000) | Admin rate limit window |
| `RATE_LIMIT_ADMIN_MAX` | number | undefined (uses default 2000) | Max admin requests per window |
| `TRACING_SAMPLE_RATE` | number (0-1) | 1 | Trace sampling rate (clamped to 0-1) |
| `TRACING_ENABLED` | boolean | false | Enable/disable tracing |
| `LOG_LEVEL` | string | 'info' | Log level (debug/info/warn/error) |
| `FEATURE_FLAGS_JSON` | string (JSON) | undefined | Inline feature flag definitions |
| `FEATURE_FLAGS_FILE` | string (path) | undefined | Path to feature flag JSON file |

## Restart-Required Keys

Changes to these keys are detected but **NOT** applied at runtime:

| Environment Variable | Behavior |
|----------------------|----------|
| `DATABASE_URL` | Warning logged, value not applied |
| `REDIS_URL` | Warning logged, value not applied |
| `JWT_SECRET` | Warning logged, value not applied |
| `INDEXER_WORKER_TOKEN` | Warning logged, value not applied |

**Security Note**: Warnings contain only the variable name, never the value (secrets are redacted).

## Validation Rules

### Rate Limits
- Must be positive integers
- Invalid values (non-numeric, negative) → `undefined` (uses runtime defaults)
- No upper bound validation in `reloadHotConfig()` (but runtime may enforce)

### Tracing Sample Rate
- Values outside [0,1] → clamped to 1
- Non-numeric values → defaults to 1
- Empty/undefined → defaults to 1

### Tracing Enabled
- `"true"`, `"1"`, `"false"`, `"0"` → parsed as boolean
- Other values → defaults to `false`
- Empty/undefined → defaults to `false`

### Log Level
- Must be one of: `debug`, `info`, `warn`, `error`
- Invalid values → defaults to `'info'`
- Empty/undefined → defaults to `'info'`

### Feature Flags
- JSON must be valid array or object format
- Invalid JSON → empty map (stderr written)
- Missing file → empty map (stderr written)
- Invalid entries (missing name/percentage) → skipped

## Error Handling

### No Retry Logic
**Current behavior**: `reloadHotConfig()` does NOT implement retry logic. It reads `process.env` once per call and returns. If the environment is in an inconsistent state, the call fails immediately.

**Rationale**: Reload is triggered by SIGHUP and is expected to be instantaneous. Retry logic would add complexity without clear benefit.

### Missing Values
All hot-reloadable keys have sensible defaults or fallbacks:
- Rate limits: `undefined` → runtime uses defaults
- Tracing sample rate: defaults to 1
- Tracing enabled: defaults to false
- Log level: defaults to 'info'
- Feature flags: empty map

## Concurrency

### Current Behavior
`reloadHotConfig()` reads from `process.env` atomically and returns a frozen object. However:
- **No explicit locking** - concurrent SIGHUP signals could interleave
- **No race condition protection** - `process.env` reads are atomic at Node.js level, but `startupEnvSnapshot` is not locked
- **In practice**: The frozen object ensures callers see a consistent snapshot, but concurrent calls may see different snapshots

### Proposed Behavior
Currently undefined. Consider:
1. Adding a mutex to prevent concurrent reloads
2. Making `startupEnvSnapshot` updates atomic
3. Documenting that concurrent reloads are not supported

## Observability

### Logging
- `warn()` called for each changed restart-only key
- Log message format: `SIGHUP: restart-only variable ${key} changed — restart required to apply`
- Structured logging with `{ variable: key }` field
- No logging for successful hot-reload operations (silent success)

### Metrics
- **No metrics** currently emitted for reload operations
- No counters for reload attempts, successes, or failures
- No timing metrics for reload duration

### Traces
- **No tracing** spans created for reload operations
- Reload operations are not visible in distributed tracing

### Security
- Warnings contain ONLY variable names, never values
- Secrets are never logged (verified in tests)

## Edge Cases

### 1. Feature Flag JSON Validation
**Behavior**: Invalid JSON → empty map + stderr write
**Test**: `parseFlagsJson` handles malformed JSON gracefully
**Regression**: Should never throw, always return a Map

### 2. Feature Flag File Not Found
**Behavior**: Returns empty map + stderr write
**Test**: File read failure caught and handled
**Regression**: Should never throw, always return a Map

### 3. Rate Limit Values
**Behavior**: Non-numeric values → `undefined`
**Test**: `parseOptionalInt` handles invalid input
**Regression**: Should always return number | undefined, never throw

### 4. Concurrent Reloads
**Behavior**: Undefined (no explicit handling)
**Test**: Not currently tested
**Regression**: Could lead to inconsistent state if concurrent

### 5. Startup Snapshot Not Captured
**Behavior**: Implicit capture on first `reloadHotConfig()` call
**Test**: `captureStartupEnvSnapshot` idempotency test
**Regression**: Should always capture before comparing

### 6. Empty Values
**Behavior**: Empty string treated as undefined
**Test**: Various parse helpers check for empty strings
**Regression**: Should never treat empty as valid value

## Regression Surface

### Critical Paths to Test

#### A. Happy Path
1. **All env vars set correctly** → returns valid HotConfig
2. **Rate limits updated** → `setRuntimeRateLimitConfig()` applies changes
3. **Feature flags reload** → `getFlags()` returns updated map

#### B. Validation Paths
1. **Invalid rate limit values** → returns `undefined` (uses defaults)
2. **Malformed feature flag JSON** → returns empty map
3. **Missing feature flag file** → returns empty map
4. **Invalid log level** → defaults to 'info'
5. **Out-of-range tracing sample** → clamps to 1

#### C. Restart-Only Detection
1. **Changed DATABASE_URL** → warning logged, value NOT applied
2. **Changed JWT_SECRET** → warning logged, value NOT applied
3. **Multiple changed keys** → one warning per changed key
4. **No changed keys** → no warnings

#### D. Concurrency
1. **Concurrent reload calls** → behavior undefined (needs testing)
2. **Reload during startup** → implicit snapshot capture works

#### E. Observability
1. **Warnings logged** → for restart-only changes
2. **No success logs** → silent success (current behavior)
3. **No metrics** → current behavior

### Backward Compatibility Guarantees
1. **Existing API** - `reloadHotConfig()` signature unchanged
2. **Existing behavior** - All current behaviors preserved
3. **No new dependencies** - All functionality remains self-contained
4. **No new required env vars** - All changes optional

## Testing Strategy

### Existing Tests (`tests/config/env.reload.test.ts`)
- ✅ Rate limit parsing from env
- ✅ Tracing and log-level parsing
- ✅ Feature flags forwarding
- ✅ Frozen object (immutability)
- ✅ Startup snapshot idempotency
- ✅ Restart-only key warnings
- ✅ Security (no secrets in logs)
- ✅ Rate limit wiring via `setRuntimeRateLimitConfig`
- ✅ Feature flag reload wiring

### Needed Tests (Edge Cases)
- ❌ Invalid rate limit values (non-numeric, negative)
- ❌ Malformed feature flag JSON
- ❌ Missing feature flag file
- ❌ Log level fallback for invalid values
- ❌ Tracing sample rate clamping for out-of-range
- ❌ Concurrent reload behavior (if defined)
- ❌ Observability (metrics, traces) - if implemented

## Configuration Flow
SIGHUP Signal
↓
reloadHotConfig()
↓
captureStartupEnvSnapshot() (if not already called)
↓
Check restart-only keys
↓
WARN for each changed restart-only key
↓
Build HotConfig from current process.env
↓
Return frozen HotConfig object
↓
Caller updates runtime state:

setRuntimeRateLimitConfig()

reloadFlags()


## Related Components

### `src/config/rateLimits.ts`
- `DEFAULT_IP_CONFIG`, `DEFAULT_APIKEY_CONFIG`, `DEFAULT_ADMIN_CONFIG`
- `getRateLimitConfig()` - reads from env with defaults
- `setRuntimeRateLimitConfig()` - applies runtime overrides
- `getRuntimeRateLimitConfig()` - retrieves current overrides

### `src/config/featureFlags.ts`
- `parseFlagsJson()` - parses JSON with error handling
- `reloadFlags()` - hot-reloads from env or file
- `getFlags()` - returns current flag map
- `isEnabled()` - checks feature flag for requester

### `src/lib/retry.ts`
- `withJitteredRetry()` - used for startup probes, NOT for env reload
- Env reload does NOT use retry logic

### SIGHUP Handler
- Expected to call `reloadHotConfig()`, `setRuntimeRateLimitConfig()`, and `reloadFlags()`
- Implementation location: likely in `src/index.ts` or `src/app.ts`

## Security Considerations

1. **Secret Redaction**: All warning messages contain only variable names, never values
2. **API Key Pepper**: Not hot-reloadable (requires restart)
3. **JWT Secret**: Not hot-reloadable (requires restart)
4. **Indexer Worker Token**: Not hot-reloadable (requires restart)
5. **Feature Flags**: Can be hot-reloaded safely (no secrets)
6. **Rate Limits**: Safe to hot-reload (operational parameters)

## Performance Impact

- **`reloadHotConfig()`**: O(1) operations, minimal overhead
- **JSON parsing**: Only on feature flag reload, cached afterward
- **Memory**: Frozen objects are small, no memory leaks expected
- **CPU**: Minimal, only on SIGHUP (infrequent)

## Known Limitations

1. **No retry**: Reload is all-or-nothing, no retry on failure
2. **No metrics**: Reload operations not observable via metrics
3. **No trace**: Reload operations not visible in distributed tracing
4. **Concurrency undefined**: Behavior with concurrent SIGHUP not specified
5. **Limited validation**: Only basic type validation, no business rule validation
6. **No rollback**: If reload succeeds but runtime update fails, no rollback

## Future Considerations

1. Add metrics for reload operations (success/failure count, duration)
2. Add distributed tracing spans for reload operations
3. Define behavior for concurrent reloads (mutex/locking)
4. Add validation for business rules (e.g., rate limits > 0)
5. Consider adding retry logic for transient failures
6. Add rollback mechanism if runtime update fails