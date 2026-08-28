- [x] Add Prometheus counter fluxora_sse_subscriber_errors_total with label reason='subscriber_callback_throw' in src/metrics/businessMetrics.ts and update deRegisterBusinessMetrics()
- [x] Update src/streams/sseEmitter.ts to log structured error (streamId + error name/message) and increment the counter when subscriber callback throws
- [x] Add test in tests/streams-sse.subscriber-observability.test.ts: one throwing subscriber + one healthy; assert metric increment and structured log emitted; ensure payload not logged

- [x] Update docs/observability.md to document the new metric

- [x] Run test suite (npm test) and ensure coverage >=95%


# TODO - #522 rpcFallbackCache key collision hardening

- [x] Implement collision-resistant, versioned v2 cache key construction in `src/redis/rpcFallbackCache.ts` (hash operation + each cachePart)

- [x] Add inline TSDoc documenting security assumptions and collision resistance
- [x] Expose a test-safe key builder (or equivalent) to allow unit tests to assert key distinctness
- [x] Add unit tests in `tests/services/stellarRpc.fallback.test.ts` proving near-colliding inputs map to different keys
- [x] Run vitest tests for the touched test file, then (if possible) full suite
- [x] Ensure coverage and formatting/lint pass
