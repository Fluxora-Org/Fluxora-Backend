# Stellar RPC Resilience

Fluxora wraps Stellar RPC calls with a circuit breaker and a last-known-good fallback cache.

## Circuit Breaker States

| State | Behavior |
| --- | --- |
| `CLOSED` | Normal operation. RPC calls are attempted and successful responses refresh the fallback cache. |
| `OPEN` | The provider is considered unhealthy. The service attempts to serve the matching cached response before throwing `CircuitOpenError`. |
| `HALF_OPEN` | A cool-off period has elapsed. One probe call is attempted against the provider; success closes the circuit and refreshes cache, failure reopens it. |

The breaker is configured with `RPC_CB_FAILURE_THRESHOLD`, `RPC_CB_WINDOW_MS`, `RPC_CB_RESET_TIMEOUT_MS`, and `RPC_TIMEOUT_MS`.

## Fallback Cache

Successful RPC responses are stored in Redis under keys beginning with `rpc:cache::`. The default TTL is 300 seconds and can be changed with `RPC_FALLBACK_CACHE_TTL_SECONDS`.

Cache keys use fixed operation names. Parameterized calls, such as account existence checks, include a SHA-256 hash of the parameter rather than raw account data. This prevents key injection, keeps key length bounded, and avoids writing account identifiers into Redis keys.

When the circuit is `OPEN`:

1. A cache hit returns the stale last-known-good response and increments `rpc_circuit_open_fallback_hits_total`.
2. A cache miss increments `rpc_circuit_open_fallback_misses_total` and propagates `CircuitOpenError`.
3. HTTP requests executed through `rpcDegradationMiddleware` include `X-RPC-Cache: stale` when a stale RPC response was used.

Redis cache read/write failures are logged as warnings and treated as misses or no-op writes. The fallback cache must not become a hard dependency for normal RPC calls.

## Security Notes

- Cached values are JSON only and are parsed with `JSON.parse`; no dynamic code execution is used.
- Raw account addresses are URL-encoded for Horizon requests and hashed before use in Redis cache keys.
- Redis credentials come from environment configuration and are never logged.
- Stale fallback responses are served only while the circuit breaker is `OPEN`; `HALF_OPEN` uses live probe calls.
