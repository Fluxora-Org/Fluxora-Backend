# Quick Reference: Standardized Error Envelope

## Response Structure

### Success Response
```typescript
{
  success: true,
  data: T,
  meta: {
    timestamp: string,  // ISO-8601
    requestId?: string  // Optional correlation ID
  }
}
```

### Error Response
```typescript
{
  success: false,
  error: {
    code: string,       // UPPER_SNAKE_CASE
    message: string,    // Human-readable
    details?: unknown,  // Optional context
    requestId?: string  // Optional correlation ID
  }
}
```

## Helper Functions

### `successResponse<T>(data: T, requestId?: string)`
Wraps data in a success envelope with timestamp and optional requestId.

**Example:**
```typescript
res.json(successResponse({ id: 'stream-123', amount: '1000' }, requestId));
```

### `errorResponse(code: string, message: string, details?: unknown, requestId?: string)`
Creates an error envelope with code, message, optional details, and optional requestId.

**Example:**
```typescript
res.status(400).json(
  errorResponse('VALIDATION_ERROR', 'Invalid input', { field: 'sender' }, requestId)
);
```

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Input validation failed |
| `INVALID_JSON` | 400 | Malformed JSON |
| `DECIMAL_ERROR` | 400 | Decimal string validation failed |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Duplicate submission |
| `PAYLOAD_TOO_LARGE` | 413 | Request exceeds size limit |
| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Dependency outage |

## Migration Examples

### Before (Old Format)
```typescript
// Success
const response = await fetch('/api/streams');
const streams = response.streams;
const timestamp = response.timestamp;

// Error
const errorCode = response.error.code;
const errorMessage = response.error.message;
```

### After (New Format)
```typescript
// Success
const response = await fetch('/api/streams');
if (response.success) {
  const streams = response.data.streams;
  const timestamp = response.meta.timestamp;
}

// Error
if (!response.success) {
  const errorCode = response.error.code;
  const errorMessage = response.error.message;
}
```

## Route Examples

### GET /api/streams
**Success (200):**
```json
{
  "success": true,
  "data": {
    "streams": [...],
    "has_more": false
  },
  "meta": {
    "timestamp": "2024-01-01T12:00:00.000Z",
    "requestId": "req-123"
  }
}
```

### POST /api/streams
**Success (201):**
```json
{
  "success": true,
  "data": {
    "id": "stream-123",
    "sender": "G...",
    "recipient": "G...",
    "depositAmount": "1000",
    "ratePerSecond": "10",
    "status": "active"
  },
  "meta": {
    "timestamp": "2024-01-01T12:00:00.000Z",
    "requestId": "req-123"
  }
}
```

**Error (400):**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "sender is required",
    "requestId": "req-123"
  }
}
```

### GET /health
**Success (200):**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "fluxora-backend",
    "network": "testnet"
  },
  "meta": {
    "timestamp": "2024-01-01T12:00:00.000Z"
  }
}
```

## Testing Examples

### Testing Success Response
```typescript
it('should return success envelope', async () => {
  const res = await request(app).get('/api/streams');
  
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data).toBeDefined();
  expect(res.body.meta.timestamp).toBeTruthy();
});
```

### Testing Error Response
```typescript
it('should return error envelope', async () => {
  const res = await request(app)
    .post('/api/streams')
    .send({ invalid: 'data' });
  
  expect(res.status).toBe(400);
  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(res.body.error.message).toBeTruthy();
});
```

## Common Patterns

### Route Handler with Success
```typescript
app.get('/api/resource', asyncHandler(async (req, res) => {
  const requestId = req.id;
  const data = await fetchData();
  res.json(successResponse(data, requestId));
}));
```

### Route Handler with Error
```typescript
app.post('/api/resource', asyncHandler(async (req, res) => {
  const requestId = req.id;
  
  if (!req.body.field) {
    throw validationError('field is required');
  }
  
  const data = await createResource(req.body);
  res.status(201).json(successResponse(data, requestId));
}));
```

### Error Handler Middleware
```typescript
app.use((err, req, res, next) => {
  const requestId = req.id;
  
  if (err instanceof ApiError) {
    res.status(err.statusCode).json(
      errorResponse(err.code, err.message, err.details, requestId)
    );
    return;
  }
  
  res.status(500).json(
    errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', undefined, requestId)
  );
});
```

## Best Practices

1. **Always include requestId** when available for debugging
2. **Use helper functions** instead of manually constructing envelopes
3. **Provide meaningful error messages** for better developer experience
4. **Include details** in errors when additional context is helpful
5. **Use appropriate HTTP status codes** matching the error type
6. **Test both success and error paths** in your route tests
7. **Document breaking changes** when updating API contracts

## Troubleshooting

### Issue: Tests failing with "Cannot read property 'data' of undefined"
**Solution:** Update test assertions to expect new envelope structure:
```typescript
// Before
expect(res.body.id).toBe('stream-123');

// After
expect(res.body.data.id).toBe('stream-123');
```

### Issue: Error responses missing requestId
**Solution:** Ensure requestId is extracted and passed to errorResponse:
```typescript
const requestId = req.id || res.locals['requestId'];
res.status(400).json(errorResponse('ERROR_CODE', 'Message', undefined, requestId));
```

### Issue: TypeScript errors on response types
**Solution:** Import types from utils/response.ts:
```typescript
import { SuccessEnvelope, ErrorEnvelope } from '../utils/response.js';
```

## Resources

- Full implementation details: `STANDARDIZED_ERROR_ENVELOPE_SUMMARY.md`
- API behavior specification: `API_BEHAVIOR.md`
- OpenAPI specification: `openapi.yaml`
- Implementation status: `IMPLEMENTATION_COMPLETE.md`
