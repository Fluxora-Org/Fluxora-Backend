# Fix OpenAPI Spec Mismatches vs Actual Responses/Status Codes

## Summary

Fixed critical mismatches between the OpenAPI specification and actual API implementation to ensure accurate client expectations and documentation.

## Changes Made

### 1. **openapi.yaml** - Complete Rewrite

- **Response Envelope Structure**: Updated all response schemas to reflect the actual standardized envelope pattern:
  - Success responses: `{ success: true, data: {...}, meta: { timestamp, requestId? } }`
  - Error responses: `{ success: false, error: { code, message, details?, requestId? } }`
- **Removed Unimplemented Endpoints**: Removed all webhook-related endpoints that are not yet implemented
- **Updated Status Codes**: Removed 422 status code (implementation uses 400 for validation errors)
- **Fixed Response Schemas**:
  - Created `StreamResponse`, `StreamListResponse`, `CancelStreamResponse` schemas that wrap data in envelope
  - Created `HealthResponse`, `ReadinessResponse`, `LivenessResponse` for health endpoints
  - Updated `ErrorResponse` schema to match actual error envelope structure
- **Added Health Endpoints**: Documented `/health/ready` and `/health/live` endpoints
- **Fixed Stream ID Format**: Updated documentation to reflect actual format `stream-{timestamp}-{random}`

### 2. **src/routes/streams.ts** - Added Missing Imports

- Added import for `successResponse` from `../utils/response.js`
- Added imports for validation helpers: `parseBody`, `formatZodIssues`, `CreateStreamSchema`
- Added imports for stream status helpers: `assertValidApiTransition`, `ApiStreamStatus`

### 3. **src/routes/health.ts** - Fixed Error Response Calls

- Corrected `errorResponse()` function calls to use correct parameter order: `(code, message, details?, requestId?)`
- Fixed `/health/ready` endpoint error responses
- Fixed `/health/live` endpoint error responses

### 4. **tests/streams.test.ts** - Updated Test Assertions

- Updated all success response assertions to access data via `response.body.data` instead of `response.body`
- Updated POST /api/streams tests to check `response.body.data.id`, `response.body.data.depositAmount`, etc.
- Updated GET /api/streams tests to check `response.body.data.streams`, `response.body.data.has_more`, etc.
- Maintained error response assertions (already at top level)

## Verification

- All responses now match the OpenAPI specification
- Standardized envelope pattern is consistently documented
- Error codes and status codes are accurate
- Tests updated to match actual response structure

## Closes

- #151 Fix OpenAPI spec mismatches vs actual responses/status codes
