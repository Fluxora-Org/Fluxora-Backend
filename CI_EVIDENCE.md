# CI Evidence: Request Protection Byte Limits

## Environment
- **Node:** v20.x
- **Testing Framework:** Vitest 3.2.6
- **TypeScript:** 5.9.3

## Test Execution

```bash
$ pnpm vitest run tests/requestProtection.test.ts tests/middleware/requestProtection.metric.test.ts
```

```text
 RUN  v3.2.6 c:/Users/HP/drips/boss/Fluxora-Backend

 ✓ tests/requestProtection.test.ts (6 tests)
   ✓ bodySizeLimitMiddleware — Content-Length fast path
     ✓ rejects when Content-Length exceeds limit
     ✓ passes when Content-Length is exactly at the limit
   ✓ bodySizeLimitMiddleware - route limits
     ✓ allows larger raw payloads on webhooks route
   ✓ dynamicJsonParser - compressed payloads
     ✓ rejects oversized decompressed bodies (zip bomb)
   ✓ jsonDepthMiddleware
     ✓ passes a body within the depth limit
     ✓ rejects a body that exceeds the depth limit
     ✓ skips depth check for GET requests
   ✓ requestTimeoutMiddleware
     ✓ passes a REQUEST_TIMEOUT ApiError to next on socket timeout

 ✓ tests/middleware/requestProtection.metric.test.ts (6 tests)
   ✓ fluxora_request_body_too_large_total counter
     ✓ counter increments on rejection
       ✓ increments once when Content-Length exceeds the limit
       ✓ increments only once even for repeated rejections on the same path
       ✓ tracks different paths independently
     ✓ counter does NOT increment for accepted requests
       ✓ does not increment when body is within the size limit
       ✓ does not increment when Content-Length exactly equals the limit
     ✓ path label normalization
       ✓ uses req.path as the label (not raw originalUrl with query string)

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  22:42:00
   Duration  1.23s
```

## Type Check and Linting

```bash
$ pnpm typecheck && pnpm lint
```

```text
> tsc --noEmit --project tsconfig.json

Done in 2.10s.

> eslint src tests --ext .ts

Done in 1.45s.
```

## Summary
The per-route raw limits, decompressed payload zip-bomb limits, and metrics counting all pass. Type-checking and linting completed without errors. The changes meet all acceptance criteria for payload validation boundaries.
