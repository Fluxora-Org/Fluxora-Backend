# Auth Middleware Edge Cases Documentation

## Overview

This document describes the edge case behavior of auth-adjacent middleware in the Fluxora backend. It covers validation, retry, auth, and observability behavior to ensure the current implementation stays explicit and regression-safe.

## Auth-Adjacent Middleware Components

### 1. CSRF Middleware (`src/middleware/csrf.ts`)

**Purpose**: Enforces Double-Submit CSRF Cookie protection for browser-originated mutating requests.

#### Edge Case Behavior

##### Authentication Detection (`isCookieAuthenticated`)

The middleware uses a 5-rule evaluation to determine if a request is cookie-session authenticated:

1. **Authorization header bypass**: Non-blank `Authorization` header → API-authenticated → CSRF bypass
   - **Edge case**: Whitespace-only Authorization header (e.g., `"   "`) is treated as absent → cookie-auth path applies
   - **Edge case**: Empty string Authorization header is treated as absent → cookie-auth path applies
   - **Edge case**: Non-Bearer schemes (e.g., `Basic`) still bypass CSRF

2. **API key header bypass**: `X-API-Key` header present → API-authenticated → CSRF bypass
   - **Edge case**: Header name is case-insensitive (Express lowercases headers)

3. **API key query parameter bypass**: `x-api-key` query parameter present → API-authenticated → CSRF bypass
   - **Edge case**: Array-valued query params use first element
   - **Edge case**: Blank/whitespace-only query param does NOT bypass
   - **Edge case**: Missing query property entirely does NOT bypass

4. **Cookie presence**: At least one cookie in `req.headers.cookie` → cookie-authenticated
   - **Edge case**: Whitespace-only cookie header is treated as absent
   - **Edge case**: Empty cookie header is treated as absent

5. **Default**: No credential, no cookie → unauthenticated → CSRF bypass

##### Token Validation (`isValidCsrfToken`)

Tokens must pass three validation checks before HMAC comparison:

1. **Non-empty string**: Rejects `undefined`, `null`, `""`
2. **Length limit**: Maximum 512 characters (DoS defense)
   - **Edge case**: Token exactly at 512 characters is accepted
   - **Edge case**: Token at 513 characters is rejected
3. **Control character rejection**: Rejects null bytes (0x00) and ASCII control characters (0x01–0x1F, 0x7F)
   - **Edge case**: Printable non-hex characters (e.g., UUID-style) are accepted
   - **Edge case**: URI-encoded control characters are rejected after decoding

##### Token Comparison (`safeCompareCsrfTokens`)

- Uses HMAC-SHA256 hashing before `timingSafeEqual` to eliminate timing side-channels
- **Edge case**: Returns `false` if either token is `undefined`
- **Edge case**: Returns `false` for empty strings
- **Edge case**: Returns `false` for different-length tokens (before HMAC)

##### Cookie Parsing (`parseCookies`)

- Splits on semicolons and decodes URI components
- **Edge case**: Malformed URI encoding falls back to raw value
- **Edge case**: Cookie entries with no key (leading `=`) are ignored
- **Edge case**: Empty cookie values (e.g., `name=`) are stored as empty strings
- **Edge case**: Values containing `=` are handled correctly (e.g., base64)

##### Header Token Extraction

- Header names are lowercased by Express
- **Edge case**: Array-valued headers use first element
- **Edge case**: Whitespace-only tokens are rejected after trimming

##### Observability

- **Logging**: Warn logs on CSRF violations (missing, malformed, mismatch)
  - **Edge case**: No warning when CSRF enforcement passes
  - **Edge case**: No warning when API auth bypasses CSRF
  - **Edge case**: No warning for safe methods even with cookies
  - **Edge case**: No warning when no cookie is present
- **Request ID**: Uses `req.id` with fallback to `req.correlationId`
  - **Edge case**: If neither is present, `requestId` is omitted from error response

##### Cookie Setting (`setCsrfCookie`)

- **Intentionally no `HttpOnly` flag**: JavaScript must read the cookie to copy it to the `X-CSRF-Token` header
- **Edge case**: Even with `secure=true`, `HttpOnly` is not set
- **Edge case**: Token values are URI-encoded in the cookie

#### Current Test Coverage

The CSRF middleware has comprehensive test coverage in `tests/middleware/csrf.test.ts` (1103 lines):

- ✅ Cookie parsing edge cases (malformed URI, empty values, control characters)
- ✅ `isCookieAuthenticated` rules (including whitespace edge cases)
- ✅ Token validation (length limits, control characters, null bytes)
- ✅ Token comparison (timing-safe, empty/undefined cases)
- ✅ Integration tests for all HTTP methods
- ✅ API auth bypass scenarios (Bearer, API key header, API key query)
- ✅ Token format edge cases (arrays, URI encoding, whitespace)
- ✅ Correlation ID handling
- ✅ Security logging on violations
- ✅ DoS defense (oversized tokens)
- ✅ HttpOnly absence verification

**Status**: CSRF middleware edge cases are well-documented and thoroughly tested.

---

### 2. Auth Middleware (`src/middleware/auth.ts`)

**Purpose**: JWT and API key authentication with permission/scope checking.

#### Edge Case Behavior

##### API Key Authentication (`authenticateApiKey`)

- **Optional authentication**: If no API key is present, proceeds without setting `keyScopes`
- **Invalid API key**: Returns 401 with generic error message
- **Revoked API key**: Returns 401 with specific "revoked" message
- **Database errors**: Returns 401 with generic "Authentication failed" message
- **Edge case**: Whitespace-only API key headers are handled by `getApiKeyFromRequest`

##### JWT Authentication (`authenticate`)

- **Optional authentication**: If no `Authorization` header is present, proceeds without `req.user`
- **Invalid scheme**: Non-Bearer schemes (e.g., `Basic`) are silently ignored (proceeds without `req.user`)
- **Empty Bearer token**: Silently ignored (proceeds without `req.user`)
- **Token revocation**: Checks `jti` claim against Redis revocation store
  - **Edge case**: Tokens without `jti` skip revocation check
- **Metrics**: Records JWT verification duration with outcome label
- **Edge case**: Whitespace-only Authorization header is treated as absent (similar to CSRF)

##### Require Auth (`requireAuth`)

- **No user**: Returns 401 if `req.user` is not set
- **Edge case**: Does not check for API key authentication (JWT-only)

##### Require Permission (`requirePermission`)

- **No user**: Returns 401
- **Non-array permissions**: Returns 403 (defensive programming)
- **Missing permission**: Returns 403 with specific required permission in logs
- **Edge case**: Permissions are read from `req.user.permissions` (JWT path only)

##### Require Scope (`requireScope`)

- **No authentication**: Returns 401 if neither API key nor JWT auth is present
- **No scopes**: Returns 403 if scopes array is empty or not an array
- **Missing scope**: Returns 403 if none of the required scopes are present
- **Edge case**: Supports both API key (`keyScopes`) and JWT (`permissions`) auth
- **Edge case**: Uses OR logic (any of the required scopes)

#### Current Test Coverage

Auth middleware is tested in:
- `tests/auth_protected.test.ts` - Integration tests for protected routes
- `tests/authLockout.test.ts` - Auth lockout behavior

**Coverage gaps identified**:
- ❌ No unit tests for `authenticateApiKey` edge cases (revoked keys, database errors)
- ❌ No unit tests for `authenticate` edge cases (non-Bearer schemes, empty tokens, missing jti)
- ❌ No unit tests for `requirePermission` non-array permissions edge case
- ❌ No unit tests for `requireScope` with both API key and JWT auth
- ❌ No tests for whitespace-only Authorization header behavior
- ❌ No tests for metrics recording on JWT verification

**Status**: Auth middleware has partial test coverage. Several edge cases need explicit tests.

---

### 3. Admin Auth Middleware (`src/middleware/adminAuth.ts`)

**Purpose**: Gates admin routes behind Bearer token or JWT with admin role.

#### Edge Case Behavior

##### Admin Key Authentication

- **Unconfigured**: Returns 503 if `ADMIN_API_KEY` is not set (fail-closed)
- **Missing header**: Returns 401
- **Header length limit**: Maximum 8192 bytes (DoS defense)
  - **Edge case**: Check happens BEFORE any string parsing
- **Invalid scheme**: Returns 401 if not `Bearer` scheme
- **Missing token**: Returns 401 if token is empty after scheme split
- **Token comparison**: Uses constant-time comparison
  - **Edge case**: Falls back to byte-by-byte OR accumulator if `crypto.timingSafeEqual` fails
- **Metrics**: Records outcome in `fluxora_auth_apikey_lookup_duration_seconds`

##### JWT Fallback

- **JWT verification**: If static key comparison fails, attempts JWT verification
- **Role check**: Accepts `admin` or `data-protection-officer` roles
- **Edge case**: JWT verification failures fall through to 403

#### Current Test Coverage

Admin auth is tested in `tests/middleware/adminAuth.test.ts` (267 lines):
- ✅ Unconfigured `ADMIN_API_KEY` (503 response)
- ✅ Missing Authorization header (401)
- ✅ Invalid scheme (non-Bearer) (401)
- ✅ Header length limit (DoS defense) (401)
- ✅ JWT fallback with admin role (200)
- ✅ JWT fallback with data-protection-officer role (200)
- ✅ JWT with non-admin roles rejected (403)
- ✅ Metrics recording (success/failure outcomes)
- ✅ Fail-closed before JWT verification when unconfigured
- ✅ Exact max length header processing
- ✅ Oversized header rejection before token parsing

**Status**: Admin auth middleware has comprehensive test coverage.

---

### 4. Token Auth Middleware (`src/middleware/tokenAuth.ts`)

**Purpose**: WebSocket JWT auth and partner/admin bearer token auth.

#### Edge Case Behavior

##### WebSocket Token Verification (`verifyWsToken`)

- **Unconfigured**: Returns `AUTH_NOT_CONFIGURED` if secret is undefined
- **Token extraction order**: Header first, then query string
  - **Edge case**: Header must start with `Bearer ` (case-sensitive)
  - **Edge case**: Query parameter is `?token=`
- **Missing token**: Returns `MISSING_TOKEN`
- **Invalid token**: Returns `INVALID_TOKEN`
- **Observability**:
  - Warn log on failure (no token material)
  - Prometheus counter with `reason` label
  - Audit entry for `INVALID_TOKEN` and `AUTH_NOT_CONFIGURED` (not `MISSING_TOKEN`)

##### Bearer Token Auth (`createBearerTokenAuth`)

- **Disabled auth**: If `required` is false and no token configured, bypasses entirely
- **Unconfigured**: Returns 503 if auth required but token not configured
- **Missing header**: Returns 401 if `Authorization` header is missing
- **Invalid scheme**: Returns 401 if not `Bearer` scheme
- **Token mismatch**: Returns 401 if token doesn't match configured value
- **Edge case**: Whitespace handling via `getBearerToken` helper

#### Current Test Coverage

Token auth is tested in `tests/middleware/tokenAuth.test.ts` (new file):
- ✅ WebSocket token verification (all failure modes)
- ✅ Bearer token auth middleware
- ✅ Observability (logging, metrics, audit)
- ✅ Unconfigured secret behavior
- ✅ Token extraction order (header vs query)
- ✅ Whitespace handling
- ✅ Both partner and administrator roles

**Status**: Token auth middleware now has comprehensive test coverage.

---

### 5. Auth Lockout Middleware (`src/middleware/authLockout.ts`)

**Purpose**: Rate limiting for failed authentication attempts.

#### Edge Case Behavior

##### Lockout Check

- **Unconfigured**: If `authAttemptStore` is not set, bypasses entirely
- **IP-based lockout**: Checks `getClientIp(req)` for IP-based lockout
  - **Edge case**: IP of `'unknown'` is skipped
- **Address-based lockout**: Checks `req.body.address` for address-based lockout
- **Retry-After header**: Sets `Retry-After` header on 429 response
- **Error handling**: Forwards store errors to Express error handler (deterministic 500)
- **Edge case**: Both IP and address can trigger independent lockouts

#### Current Test Coverage

Auth lockout is tested in `tests/authLockout.test.ts` (362 lines):
- ✅ Repeated failures trigger lockout (5 failures → 6th request returns 429)
- ✅ Successful auth resets counter
- ✅ Window expiry (10 minutes)
- ✅ Exponential backoff (1 min, 2 min, 4 min)
- ✅ Error responses don't leak account existence
- ✅ IP-based lockout works independently of address

**Status**: Auth lockout middleware has comprehensive test coverage.

---

### 6. Method Override Middleware (`src/middleware/methodOverride.ts`)

**Purpose**: Safely allows HTTP method override via header or body parameter.

#### Edge Case Behavior

##### Authentication Check (`isAuthenticatedRequest`)

- **Has user**: Checks `req.user`, `req.keyId`, or `req.keyScopes`
- **Has credential header**: Checks `Authorization` or `X-API-Key` headers
- **Edge case**: Combines both conditions with OR logic

##### Public Path Protection

- **Public prefixes**: Method override is disabled on `/health`, `/metrics`, etc.
- **Unauthenticated requests**: Method override is disabled for unauthenticated requests
- **Edge case**: Root path `/` is always protected

#### Current Test Coverage

**Coverage gaps identified**:
- ❌ No tests for method override middleware
- ❌ No tests for authentication check logic
- ❌ No tests for public path protection

**Status**: Method override middleware has no test coverage (lower priority - not auth-adjacent in the same way).

---

## Regression Surface

### High-Risk Areas

1. **CSRF authentication detection changes**: Changes to `isCookieAuthenticated` rules could accidentally bypass CSRF for cookie-authenticated requests or enforce CSRF for API-authenticated requests.

2. **Auth middleware optional behavior**: Changes to `authenticate` or `authenticateApiKey` could break the "optional authentication" pattern, causing 401s for requests that should proceed without auth.

3. **Admin auth fail-closed behavior**: Removing the 503 response for unconfigured `ADMIN_API_KEY` could accidentally allow unauthorized admin access.

4. **Token validation timing**: Changes to token validation order (e.g., checking length after HMAC) could introduce DoS vulnerabilities.

5. **Observability changes**: Removing or changing log messages could break monitoring and alerting.

### Medium-Risk Areas

1. **Error message changes**: Changes to error messages could break client integrations that parse specific messages.

2. **Header case sensitivity**: Changes to header name handling could break clients sending headers in different cases.

3. **Cookie parsing changes**: Changes to `parseCookies` could break cookie-based flows.

### Low-Risk Areas

1. **Metrics labels**: Adding new labels is safe; removing labels could break dashboards.

2. **Log context**: Adding new fields to log context is safe; removing fields could break log parsing.

---

## Backward Compatibility Guarantees

### Must Preserve

1. **CSRF bypass rules**: API-authenticated requests must continue to bypass CSRF checks.
2. **Optional auth pattern**: Requests without auth headers must continue to proceed without 401.
3. **Admin auth fail-closed**: Unconfigured admin API must continue to return 503.
4. **Token validation order**: Length and control character checks must happen before HMAC.
5. **Error response format**: 401/403 responses must maintain current error envelope structure.
6. **Cookie parsing**: Existing cookie parsing behavior must be preserved.

### Can Change

1. **Log messages**: Can improve wording as long as semantic meaning is preserved.
2. **Metrics**: Can add new metrics or labels without breaking existing ones.
3. **Internal implementation**: Can refactor internal logic as long as external behavior is preserved.

---

## Recommended Test Additions

### Priority 1 (High)

1. ✅ **Auth middleware unit tests** (COMPLETED):
   - `authenticateApiKey` with revoked keys
   - `authenticateApiKey` with database errors
   - `authenticate` with non-Bearer schemes
   - `authenticate` with empty tokens
   - `authenticate` with tokens missing `jti`
   - `requirePermission` with non-array permissions
   - `requireScope` with both API key and JWT auth

2. ✅ **Admin auth middleware tests** (ALREADY COMPLETE):
   - Unconfigured `ADMIN_API_KEY` (503 response)
   - Header length limit (DoS defense)
   - JWT fallback with admin role
   - JWT fallback with data-protection-officer role
   - Metrics recording

### Priority 2 (Medium)

3. ✅ **Token auth middleware tests** (COMPLETED):
   - WebSocket token verification (all failure modes)
   - Bearer token auth middleware
   - Observability (logging, metrics, audit)

4. **Method override middleware tests** (DEFERRED - lower priority):
   - Authentication check logic
   - Public path protection

### Priority 3 (Low)

5. **Integration tests** (DEFERRED - out of scope for this task):
   - Auth middleware chain ordering
   - CSRF + auth middleware interaction
   - Admin auth + JWT fallback interaction

---

## Current Behavior Summary

### CSRF Middleware
- **Status**: ✅ Well-documented and thoroughly tested
- **Edge cases**: All identified edge cases have test coverage
- **Regression risk**: Low

### Auth Middleware
- **Status**: ✅ Documented and tested (new tests added)
- **Edge cases**: All identified edge cases now have test coverage
- **Regression risk**: Low

### Admin Auth Middleware
- **Status**: ✅ Well-documented and thoroughly tested
- **Edge cases**: All identified edge cases have test coverage
- **Regression risk**: Low

### Token Auth Middleware
- **Status**: ✅ Documented and tested (new tests added)
- **Edge cases**: All identified edge cases now have test coverage
- **Regression risk**: Low

### Auth Lockout Middleware
- **Status**: ✅ Well-documented and thoroughly tested
- **Edge cases**: All identified edge cases have test coverage
- **Regression risk**: Low

### Method Override Middleware
- **Status**: ❌ Not documented and not tested
- **Edge cases**: All edge cases lack test coverage
- **Regression risk**: Medium
