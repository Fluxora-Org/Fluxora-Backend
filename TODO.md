# TODO - #522 rpcFallbackCache key collision hardening

- [x] Implement collision-resistant, versioned v2 cache key construction in `src/redis/rpcFallbackCache.ts` (hash operation + each cachePart)

- [ ] Add inline TSDoc documenting security assumptions and collision resistance
- [ ] Expose a test-safe key builder (or equivalent) to allow unit tests to assert key distinctness
- [ ] Add unit tests in `tests/services/stellarRpc.fallback.test.ts` proving near-colliding inputs map to different keys
- [ ] Run vitest tests for the touched test file, then (if possible) full suite
- [ ] Ensure coverage and formatting/lint pass

