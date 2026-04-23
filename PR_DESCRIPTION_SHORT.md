# Brief Commit Message

```
feat: standardize error envelope across all routes

BREAKING CHANGE: All API responses now use standardized envelope structure
```

---

# Short PR Description

## Summary

Standardize response envelopes across all API routes for consistency and better developer experience.

## Changes

- Updated `src/utils/response.ts` with restructured error envelope
- Modified `src/middleware/errorHandler.ts` to use standardized helpers
- Wrapped all route responses in success/error envelopes (8 route files)
- Updated tests to expect new envelope structure (3 test files)
- Updated documentation: `API_BEHAVIOR.md` and `openapi.yaml`

## Response Structure

**Success:**
```json
{
  "success": true,
  "data": { /* payload */ },
  "meta": { "timestamp": "...", "requestId": "..." }
}
```

**Error:**
```json
{
  "success": false,
  "error": { "code": "...", "message": "...", "requestId": "..." }
}
```

## Breaking Changes

⚠️ Clients must update response parsing:
- Access data through `response.data` instead of `response`
- Access errors through `response.error` instead of `response.error.{field}`
- Error codes changed from `snake_case` to `UPPER_SNAKE_CASE`

## Benefits

- ✅ Consistent API surface across all endpoints
- ✅ Better debugging with requestId in all responses
- ✅ Type-safe response handling
- ✅ Follows REST API best practices

## Testing

- ✅ All tests updated and passing
- ✅ No TypeScript errors
- ✅ Decimal string serialization preserved

## Files Changed

21 files: +2,188 lines, -197 lines

---

**Ready for review**
