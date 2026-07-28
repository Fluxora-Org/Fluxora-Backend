- [ ] Add Prometheus counter fluxora_sse_subscriber_errors_total with label reason='subscriber_callback_throw' in src/metrics/businessMetrics.ts and update deRegisterBusinessMetrics()
- [ ] Update src/streams/sseEmitter.ts to log structured error (streamId + error name/message) and increment the counter when subscriber callback throws
- [ ] Add test in tests/routes/streams-sse.test.ts: one throwing subscriber + one healthy; assert metric increment and structured log emitted; ensure payload not logged

- [x] Update docs/observability.md to document the new metric

- [ ] Run test suite (npm test) and ensure coverage >=95%


# TODO - #522 rpcFallbackCache key collision hardening

- [x] Implement collision-resistant, versioned v2 cache key construction in `src/redis/rpcFallbackCache.ts` (hash operation + each cachePart)

- [ ] Add inline TSDoc documenting security assumptions and collision resistance
- [ ] Expose a test-safe key builder (or equivalent) to allow unit tests to assert key distinctness
- [ ] Add unit tests in `tests/services/stellarRpc.fallback.test.ts` proving near-colliding inputs map to different keys
- [ ] Run vitest tests for the touched test file, then (if possible) full suite
- [ ] Ensure coverage and formatting/lint pass

