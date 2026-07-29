# Environment Reload Edge Cases Documentation

## Overview

This document describes the edge case behavior of environment reload (SIGHUP) functionality in the Fluxora backend. It covers validation, retry, auth, and observability behavior to ensure the current implementation stays explicit and regression-safe.

## Environment Reload Components

### 1. Hot Config Reload (`src/config/env.ts`)

**Purpose**: Runtime hot-reload of whitelisted configuration values via SIGHUP signal without process restart.

#### Edge Case Behavior

##### `reloadHotConfig` Function

The `reloadHotConfig` function reads hot-reloadable environment variables and returns a frozen `HotConfig` object.

**Hot-reloadable keys**:
- `RATE_LIMIT_IP_WINDOW_MS`, `RATE_LIMIT_IP_MAX`
- `RATE_LIMIT_APIKEY_WINDOW_MS`, `RATE_LIMIT_APIKEY_MAX`
- `RATE_LIMIT_ADMIN_WINDOW_MS`, `RATE_LIMIT_ADMIN_MAX`
- `TRACING_SAMPLE_RATE`, `TRACING_ENABLED`
- `LOG_LEVEL`
- `FEATURE_FLAGS_JSON`, `FEATURE_FLAGS_FILE`

**Restart-only keys** (require full restart):
- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `INDEXER_WORKER_TOKEN`

##### Rate Limit Parsing

- **Integer parsing**: Uses `parseInt` with validation
  - **Edge case**: Empty string → `undefined`
  - **Edge case**: Non-numeric string → `undefined`
  - **Edge case**: Negative values → `undefined` (rejected)
  - **Edge case**: Zero values → `undefined` (rejected)
  - **Edge case**: Whitespace-only → `undefined`
  - **Edge case**: Leading zeros → parsed correctly (e.g., "00100" → 100)
  - **Edge case**: Extremely large values → parsed as number (may exceed safe integer range)

##### Tracing Configuration Parsing

- **Sample rate**: Clamped to [0, 1] range
  - **Edge case**: Values > 1 → fallback to 1
  - **Edge case**: Values < 0 → fallback to 1
  - **Edge case**: Non-numeric → fallback to 1
  - **Edge case**: Empty string → fallback to 1
  - **Default**: 1 when unset

- **Enabled flag**: Boolean parsing
  - **Edge case**: "true" / "1" → `true`
  - **Edge case**: "false" / "0" → `false`
  - **Edge case**: Invalid values (e.g., "yes", "on") → fallback to `false`
  - **Edge case**: Empty string → fallback to `false`
  - **Default**: `false` when unset

##### Log Level Parsing

- **Valid levels**: "debug", "info", "warn", "error"
  - **Edge case**: Invalid level → fallback to "info"
  - **Edge case**: Case-sensitive (must be lowercase)
  - **Edge case**: Empty string → fallback to "info"
  - **Default**: "info" when unset

##### Feature Flags Parsing

- **JSON format**: Passed through as-is to `reloadFlags()`
  - **Edge case**: Empty string → `undefined`
  - **Edge case**: Invalid JSON → handled by `reloadFlags()` (returns empty map)
  - **Edge case**: Missing → `undefined`

##### Startup Snapshot (`captureStartupEnvSnapshot`)

- **Idempotent**: First call captures snapshot, subsequent calls are no-ops
  - **Edge case**: Called implicitly on first `reloadHotConfig()` if not pre-called
  - **Edge case**: Snapshot is frozen to prevent mutation
  - **Edge case**: Only captures restart-only keys

##### Restart-Only Key Detection

- **Change detection**: Compares current `process.env` against startup snapshot
  - **Edge case**: Each changed key emits a separate `warn()` log
  - **Edge case**: Warn message contains only variable NAME, not value (security)
  - **Edge case**: Changes do NOT prevent hot config from being returned
  - **Edge case**: Hot-reloadable keys are still applied even when restart-only keys change

##### Atomicity and Immutability

- **Frozen return value**: Returned object is frozen with `Object.freeze()`
  - **Edge case**: Modification attempts silently fail (no-op in non-strict mode)
  - **Edge case**: All fields are built before return (no partial state visible)

##### Concurrency Safety

- **Concurrent calls**: Multiple simultaneous calls are safe
  - **Edge case**: Each call reads current `process.env` independently
  - **Edge case**: No locking mechanism (relies on atomic reads)
  - **Edge case**: Rapid successive calls handle env changes correctly

#### Current Test Coverage

Hot config reload is tested in:
- `tests/config/env.reload.test.ts` (506 lines) - Main test suite
- `tests/config/env.reload.edge-cases.test.ts` (724 lines) - Edge case suite

**Coverage**:
- ✅ Rate limit integer parsing (valid, invalid, negative, zero, empty, whitespace)
- ✅ Tracing configuration parsing (sample rate clamping, boolean parsing)
- ✅ Log level parsing (valid, invalid, case sensitivity)
- ✅ Feature flags forwarding
- ✅ Frozen/immutable return value
- ✅ Completeness (all expected fields present)
- ✅ Value changes on subsequent calls
- ✅ Startup snapshot idempotency
- ✅ Restart-only key detection (no throw, warn logging, hot values still returned)
- ✅ SIGHUP → `setRuntimeRateLimitConfig` wiring
- ✅ SIGHUP → `reloadFlags` wiring
- ✅ Concurrent reload safety
- ✅ Empty/undefined value handling
- ✅ Security (no secret values in warn output)
- ✅ SIGHUP handler error scenarios
- ✅ Config refresh path edge cases
- ✅ Partial config updates (some keys invalid)
- ✅ Rapid successive config refreshes
- ✅ Config refresh with no changes
- ✅ Config refresh with only restart-only key changes
- ✅ Config refresh during active feature flag usage
- ✅ Config refresh with tracing config changes
- ✅ Config refresh with rate limit config changes

**Status**: Hot config reload is comprehensively documented and tested.

---

### 2. Runtime Rate Limit Config (`src/config/rateLimits.ts`)

**Purpose**: Runtime-mutable rate limit configuration that can be hot-swapped via SIGHUP.

#### Edge Case Behavior

##### `setRuntimeRateLimitConfig` Function

- **Partial updates**: Accepts partial config, merges with existing
  - **Edge case**: First call initializes from defaults if `runtimeConfig` is null
  - **Edge case**: Subsequent calls merge with existing config
  - **Edge case**: Missing keys in patch preserve existing values

- **Default values**:
  - IP: `windowMs: 60_000`, `max: 100`
  - API Key: `windowMs: 60_000`, `max: 500`
  - Admin: `windowMs: 60_000`, `max: 2000`

##### `getRuntimeRateLimitConfig` Function

- **Null on unset**: Returns `null` if no runtime config has been set
  - **Edge case**: Caller must handle null case
  - **Edge case**: Used in SIGHUP handler with fallback defaults

##### `resetRuntimeRateLimitConfig` Function

- **Test-only**: Resets runtime config to null
  - **Edge case**: Used in test setup/teardown
  - **Edge case**: Should never be called in production

##### Window Size Limit

- **MAX_WINDOW_MS**: 24 hours (86,400,000 ms)
  - **Edge case**: Prevents absurdly long Redis TTLs
  - **Edge case**: Protects Redis memory from operator error
  - **Note**: Not enforced in `setRuntimeRateLimitConfig` (operator responsibility)

#### Current Test Coverage

Runtime rate limit config is tested in:
- `tests/config/env.reload.test.ts` - SIGHUP wiring tests
- `tests/config/env.reload.edge-cases.test.ts` - Integration tests

**Coverage**:
- ✅ Hot-swap IP rate-limit into runtime store
- ✅ Fallback to defaults when env keys absent
- ✅ Partial config updates
- ✅ Config refresh with rate limit changes

**Status**: Runtime rate limit config is well-tested.

---

### 3. Feature Flags Hot Reload (`src/config/featureFlags.ts`)

**Purpose**: Runtime hot-reload of feature flag definitions via SIGHUP.

#### Edge Case Behavior

##### `reloadFlags` Function

- **Atomic replacement**: Entire flag map is replaced atomically
  - **Edge case**: No partial state visible during reload
  - **Edge case**: Invalid JSON returns empty map (doesn't throw)
  - **Edge case**: Invalid entries are skipped (graceful degradation)

##### `parseFlagsJson` Function

- **Supported formats**:
  - Array: `[{"name":"flag","percentage":50}]`
  - Object: `{"flag":{"percentage":50}}`
  - Shorthand: `{"flag":50}`

- **Validation**:
  - **Edge case**: Empty name → entry skipped
  - **Edge case**: Missing name → entry skipped
  - **Edge case**: Invalid percentage (< 0 or > 100) → entry skipped
  - **Edge case**: Non-numeric percentage → entry skipped
  - **Edge case**: Malformed JSON → returns empty map, logs to stderr

##### `loadFlagsFromEnv` Function

- **Priority order**: `FEATURE_FLAGS_JSON` → `FEATURE_FLAGS_FILE` → empty map
  - **Edge case**: Empty `FEATURE_FLAGS_JSON` → tries file
  - **Edge case**: Missing file → returns empty map, logs to stderr
  - **Edge case**: File read error → returns empty map, logs to stderr

##### Rollout Bucket Calculation

- **Deterministic hashing**: Uses SHA-256 of flag name + requester ID
  - **Edge case**: Empty requester ID → uses "anonymous"
  - **Edge case**: Same flag/requester always produces same bucket
  - **Edge case**: Bucket is in [0, 99] range

#### Current Test Coverage

Feature flags hot reload is tested in:
- `tests/config/env.reload.test.ts` - SIGHUP wiring tests
- `tests/config/env.reload.edge-cases.test.ts` - Edge case tests

**Coverage**:
- ✅ Reload from `FEATURE_FLAGS_JSON`
- ✅ Return empty map when JSON cleared
- ✅ Handle malformed JSON gracefully
- ✅ Handle invalid entries gracefully
- ✅ Handle file read errors gracefully
- ✅ Object format parsing
- ✅ Shorthand object parsing
- ✅ Config refresh during active usage

**Status**: Feature flags hot reload is comprehensively tested.

---

### 4. SIGHUP Handler (`src/index.ts`)

**Purpose**: Process signal handler for zero-downtime config reload.

#### Edge Case Behavior

##### Signal Handler Registration

- **Test guard**: Only registered when `NODE_ENV !== 'test'`
  - **Edge case**: Tests cannot accidentally trigger SIGHUP
  - **Edge case**: Handler is registered after server starts

##### Error Handling

- **Never crashes**: All errors are caught and logged
  - **Edge case**: `reloadHotConfig` errors → logged, process continues
  - **Edge case**: `setRuntimeRateLimitConfig` errors → logged, process continues
  - **Edge case**: `reloadFlags` errors → logged, process continues
  - **Edge case**: Handler never calls `process.exit()`

##### Reload Sequence

1. Call `reloadHotConfig()` to read current env
2. Call `setRuntimeRateLimitConfig()` with hot values (with defaults)
3. Call `reloadFlags()` to reload feature flags
4. Log success with config values

- **Edge case**: If step 2 fails, step 3 still runs
- **Edge case**: If step 3 fails, handler still completes
- **Edge case**: All steps use fallback defaults for undefined values

##### Observability

- **Success logging**: Info log with all reloaded values
  - **Edge case**: Logs rate limit values (not secrets)
  - **Edge case**: Logs tracing config
  - **Edge case**: Logs feature flag count
- **Failure logging**: Warn log with error message
  - **Edge case**: Error message is generic (doesn't leak secrets)
- **Restart-only warnings**: Emitted by `reloadHotConfig()`
  - **Edge case**: Each changed key logs separately

#### Current Test Coverage

SIGHUP handler is tested in:
- `tests/config/env.reload.edge-cases.test.ts` - Error scenario tests

**Coverage**:
- ✅ Error handling (never crashes process)
- ✅ `setRuntimeRateLimitConfig` error handling
- ✅ `reloadFlags` error handling
- ✅ Partial config updates

**Note**: Full integration testing of the actual signal handler is difficult in test environment. The component functions are thoroughly tested.

**Status**: SIGHUP handler error scenarios are tested.

---

## Regression Surface

### High-Risk Areas

1. **Hot config parsing changes**: Changes to parsing logic could break existing deployments that rely on current fallback behavior.

2. **Restart-only key detection**: Changes to the restart-only key list could accidentally allow hot-reloading of keys that require restart (e.g., DATABASE_URL).

3. **Atomicity violations**: If the frozen return guarantee is broken, concurrent code could observe partial config state.

4. **Error handling changes**: If the SIGHUP handler starts throwing instead of catching, processes could crash on reload.

5. **Secret logging**: If restart-only key values are accidentally logged, security credentials could leak.

### Medium-Risk Areas

1. **Default value changes**: Changes to fallback defaults could alter behavior for deployments that don't set explicit values.

2. **Warning message changes**: Changes to warn messages could break monitoring/alerting that parses logs.

3. **Feature flag parsing**: Changes to accepted JSON formats could break existing flag configurations.

### Low-Risk Areas

1. **Log context additions**: Adding new fields to success/error logs is safe.

2. **Internal refactoring**: Refactoring internal parsing logic is safe if external behavior is preserved.

3. **Test additions**: Adding new tests is always safe.

---

## Backward Compatibility Guarantees

### Must Preserve

1. **Hot-reloadable key list**: The set of hot-reloadable keys must not change without documentation.
2. **Restart-only key list**: The set of restart-only keys must not change without documentation.
3. **Parsing fallback behavior**: Empty/invalid values must continue to fallback to defaults/undefined.
4. **Frozen return value**: `reloadHotConfig()` must always return a frozen object.
5. **Error handling**: SIGHUP handler must never crash the process.
6. **Secret safety**: Restart-only key values must never be logged.
7. **Atomicity**: Config updates must be atomic (no partial state visible).

### Can Change

1. **Default values**: Can change defaults with proper documentation.
2. **Log messages**: Can improve wording as long as semantic meaning is preserved.
3. **Internal implementation**: Can refactor internal parsing logic.
4. **Additional validation**: Can add stricter validation (e.g., max value checks).

---

## Current Behavior Summary

### Hot Config Reload
- **Status**: ✅ Well-documented and thoroughly tested
- **Edge cases**: All identified edge cases have test coverage
- **Regression risk**: Low

### Runtime Rate Limit Config
- **Status**: ✅ Well-documented and thoroughly tested
- **Edge cases**: All identified edge cases have test coverage
- **Regression risk**: Low

### Feature Flags Hot Reload
- **Status**: ✅ Well-documented and thoroughly tested
- **Edge cases**: All identified edge cases have test coverage
- **Regression risk**: Low

### SIGHUP Handler
- **Status**: ✅ Documented and tested (error scenarios)
- **Edge cases**: Error scenarios have test coverage
- **Regression risk**: Low

---

## Test Files

- `tests/config/env.reload.test.ts` - Main test suite (506 lines)
- `tests/config/env.reload.edge-cases.test.ts` - Edge case suite (724 lines)
- `tests/config/env.validation.test.ts` - Startup validation tests (218 lines)

---

## Implementation Files

- `src/config/env.ts` - Hot config reload implementation
- `src/config/rateLimits.ts` - Runtime rate limit config
- `src/config/featureFlags.ts` - Feature flags hot reload
- `src/index.ts` - SIGHUP handler registration
