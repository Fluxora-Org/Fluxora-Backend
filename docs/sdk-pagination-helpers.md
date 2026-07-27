# SDK Pagination Helpers Documentation

## Overview

This document describes the SDK pagination helpers in the Stellar Fluxora backend, focusing on the `sdk/typescript/src/pagination.ts` module and its validation schema. The pagination system provides cursor-based and offset-based pagination for API endpoints, with robust validation and error handling.

## Current Implementation Architecture

### Core Pagination Module

The `pagination.ts` module in the TypeScript SDK serves as the central hub for pagination functionality, exporting:

- **`StreamPaginator` class**: Cursor-based paginator for GET /api/streams
- **Validation schema**: Zod schemas for pagination parameters
- **Type definitions**: Request/response interfaces for pagination

### Pagination Categories

1. **Cursor-Based Pagination**
   - `StreamPaginator` class for GET /api/streams
   - Uses opaque base64url tokens as cursors
   - Supports `nextPage()` and `autoPaginate()` methods

2. **Offset-Based Pagination**
   - `OffsetPaginationSchema` for webhook management and other list endpoints
   - Uses `limit` and `offset` parameters
   - Applied to various list endpoints

## Key Components

### 1. `StreamPaginator` Class

**Purpose**: Cursor-based paginator for the GET /api/streams endpoint.

**Design Principles**:

- **Opaque cursors**: Cursors are base64url tokens treated as black boxes
- **Ergonomic API**: No need for callers to manage raw cursor tokens
- **Two access patterns**: `nextPage()` for page-by-page access, `autoPaginate()` for automatic iteration

**Public API**:

```typescript
export class StreamPaginator {
  // Constructor
  constructor(
    fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>,
    params?: ListStreamsParams
  );

  // Fetch next page
  async nextPage(): Promise<Stream[] | null>;

  // Auto-paginate (async generator)
  async *autoPaginate(): AsyncGenerator<Stream, void, unknown>;
}
```

**Behavior**:

- **Cursor management**: Automatically manages `nextCursor` state
- **Termination detection**: Stops when server returns `has_more: false`
- **Error handling**: Throws on invalid `limit` values (outside 1–100 range)
- **State tracking**: Maintains `hasMore` flag to track pagination state

### 2. Validation Schemas

#### `PaginationSchema`

**Purpose**: Zod schema for cursor-based pagination query parameters on GET /api/streams.

**Fields**:

- `cursor`: Opaque cursor (optional, non-empty string)
- `limit`: Page size (1–100, default 20)
- `status`: Filter by stream status (optional)
- `sender`: Filter by sender address (optional)
- `recipient`: Filter by recipient address (optional)
- `include_total`: Include total count (optional)

**Validation Rules**:

- `limit` capped at 100 to prevent unbounded table scans
- `cursor` validated as non-empty string before decoding
- All values passed as parameterized query arguments (no string interpolation)

#### `OffsetPaginationSchema`

**Purpose**: Zod schema for offset-based pagination used by webhook management and other list endpoints.

**Fields**:

- `limit`: Page size (1–100, optional)
- `offset`: Record offset (optional)
- Other endpoint-specific filters

### 3. Type Definitions

#### `ListStreamsParams`

**Purpose**: Request parameters for GET /api/streams.

**Fields**:

- `cursor`: Opaque cursor (optional)
- `limit`: Page size (optional, 1–100)
- `status`: Stream status filter (optional)
- `sender`: Sender address filter (optional)
- `recipient`: Recipient address filter (optional)
- `include_total`: Include total count (optional)

#### `StreamListResponse`

**Purpose**: Response type for GET /api/streams.

**Fields**:

- `data`: Array of `Stream` objects
- `has_more`: Boolean indicating if more pages are available
- `next_cursor`: Opaque cursor for next page (optional)
- `meta`: Response metadata (optional)

## Security Considerations

### Input Validation

1. **Cursor Validation**
   - Cursors are validated as non-empty strings before decoding
   - Structural validation performed by `decodeCursor()` in the route
   - Prevents injection via crafted tokens

2. **Limit Validation**
   - Capped at 100 to prevent unbounded table scans
   - Coerced from string to integer
   - Validated as integer within range

3. **Parameter Binding**
   - All values passed as parameterized query arguments
   - No string interpolation occurs
   - Prevents SQL injection

### Data Protection

- **Opaque cursors**: Clients must treat cursors as black boxes
- **No manual construction**: Cursors cannot be constructed or decoded manually
- **Protocol documentation**: Full cursor protocol in `docs/openapi/README.md`

## Testing Coverage

### Current Test Status

**No existing tests** for pagination functionality in the TypeScript SDK:

- No `pagination.test.ts` file found
- No test coverage for `StreamPaginator`
- No validation schema tests

### Testing Recommendations

**Unit Tests Needed**:

1. **`StreamPaginator` tests**
   - Constructor validation (limit range)
   - `nextPage()` behavior with mock responses
   - `autoPaginate()` generator behavior
   - Cursor state management
   - Termination detection

2. **Validation Schema tests**
   - `PaginationSchema` validation rules
   - `OffsetPaginationSchema` validation rules
   - Error cases (invalid limit, cursor, etc.)

3. **Integration tests**
   - Actual API endpoint calls
   - Cursor round-trip validation
   - Large dataset handling

## Current Behavior (Happy Path)

### Cursor-Based Pagination Flow

1. **Paginator instantiation**

   ```typescript
   const paginator = new StreamPaginator(fetchPage, { limit: 20, status: 'active' });
   ```

2. **Page-by-page access**

   ```typescript
   const page1 = await paginator.nextPage(); // Returns array of streams or null
   const page2 = await paginator.nextPage(); // Returns next page or null
   ```

3. **Automatic pagination**
   ```typescript
   for await (const stream of paginator.autoPaginate()) {
     console.log(stream.id, stream.depositAmount);
   }
   ```

### Validation Flow

1. **Schema validation**

   ```typescript
   const validated = PaginationSchema.parse({
     limit: '20',
     status: 'active',
     cursor: 'eyJ2ZXJzaW9uIjoxLCJsYXN0SWQiOiJ...',
   });
   ```

2. **Route processing**
   - Validated parameters passed to route handler
   - Cursor decoded and validated
   - Query executed with parameterized arguments

## Expected Regression Surface

### High-Risk Changes

1. **Altering `StreamPaginator` constructor signature**
   - **Impact**: Breaks existing SDK usage
   - **Risk**: High - affects all SDK consumers

2. **Removing cursor validation**
   - **Impact**: Could allow malformed cursors
   - **Risk**: High - security vulnerability

3. **Changing limit range**
   - **Impact**: Could cause performance issues or API errors
   - **Risk**: High - affects pagination behavior

### Medium-Rish Changes

1. **Modifying error messages**
   - **Impact**: Could break error handling in SDK consumers
   - **Risk**: Medium - API contract change

2. **Adding new required parameters**
   - **Impact**: Breaks backward compatibility
   - **Risk**: Medium - SDK consumers would need updates

### Low-Risk Changes

1. **Adding new pagination methods**
   - **Impact**: Increases functionality but doesn't break existing code
   - **Risk**: Low - additive change

2. **Refactoring internal implementation**
   - **Impact**: May affect performance but not behavior
   - **Risk**: Low - as long as contracts are preserved

## Backward Compatibility

### Guaranteed Compatibility

- **All public class signatures remain unchanged**
- **All validation rules remain the same**
- **All error messages remain identical**
- **All cursor semantics preserved**

### Compatibility Considerations

- **Cursor format**: Opaque tokens must remain base64url encoded
- **Limit range**: 1–100 range must be maintained
- **API contract**: All endpoint interactions must remain the same
- **Type definitions**: All exported types must remain compatible

## Python SDK Comparison

### `sdk/python/fluxora/pagination.py`

**Similar functionality** but with different implementation:

1. **Cursor-based pagination**
   - Similar `StreamPaginator` class
   - Uses same opaque cursor approach
   - Similar `next_page()` and `auto_paginate()` methods

2. **Validation**
   - Uses Pydantic instead of Zod
   - Similar validation rules
   - Same security considerations

3. **API differences**
   - Method naming: `next_page()` vs `nextPage()`
   - Type hints: Python type annotations vs TypeScript interfaces
   - Error handling: Different exception types

## Recommendations for Future Enhancements

### Immediate Improvements

1. **Add comprehensive tests**
   - Unit tests for `StreamPaginator`
   - Validation schema tests
   - Integration tests with mock API

2. **Add TypeScript definitions for tests**
   - Create `pagination.test-d.ts` for type definitions
   - Improve type safety in tests

3. **Add performance monitoring**
   - Track pagination performance
   - Monitor cursor usage patterns

### Long-Term Enhancements

1. **Add pagination statistics**
   - Track number of pages fetched
   - Monitor pagination performance
   - Add metrics for pagination usage

2. **Add pagination caching**
   - Cache pagination state
   - Reduce redundant API calls

3. **Add pagination configuration**
   - Allow customization of default page size
   - Add pagination strategy options

## Conclusion

The SDK pagination helpers provide robust cursor-based and offset-based pagination for API endpoints. The current implementation balances ergonomic API design with security and validation requirements. However, the lack of test coverage represents a significant risk for future maintenance and enhancements.

The regression surface is well-understood, with clear boundaries between stable contracts and implementation details. Any changes should respect the existing validation rules and security guarantees while maintaining backward compatibility.

**Critical Action Items**:

1. **Add comprehensive test coverage** for pagination functionality
2. **Document validation rules** in detail
3. **Add performance monitoring** for pagination operations
4. **Ensure consistency** between TypeScript and Python SDK implementations
