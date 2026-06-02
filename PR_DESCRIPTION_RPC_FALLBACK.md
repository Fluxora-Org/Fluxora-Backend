## Summary

Adds a Redis-backed last-known-good fallback cache for Stellar RPC calls so callers can receive stale-but-functional data while the RPC circuit breaker is OPEN.

## Changes

- Cache successful Stellar RPC responses with configurable `RPC_FALLBACK_CACHE_TTL_SECONDS`.
- Serve cached responses on OPEN circuit hits before throwing `CircuitOpenError`.
- Add `X-RPC-Cache: stale` for HTTP responses that used stale RPC fallback data.
- Track `rpc_circuit_open_fallback_hits_total` and `rpc_circuit_open_fallback_misses_total`.
- Document circuit breaker states, fallback behavior, TTL, metrics, and security assumptions.
- Add focused tests for CLOSED, OPEN hit/miss, HALF_OPEN probe, TTL expiry, parameter isolation, and stale response headers.

## Validation

- `npm exec vitest -- run tests/services/stellarRpc.fallback.test.ts`
- `npm exec vitest -- run tests/stellar-rpc.test.ts`
- `npm exec tsc -- --noEmit --target ES2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck src/services/stellar-rpc.ts src/middleware/rpcDegradation.ts src/redis/rpcFallbackCache.ts src/metrics/rpcMetrics.ts tests/services/stellarRpc.fallback.test.ts`

## Security Notes

- Raw account identifiers are hashed before use in Redis cache keys.
- Cache keys use fixed operation names and safe hashed parts only.
- Cached values are JSON serialized and never evaluated.
- Redis failures degrade to cache misses or no-op writes.
