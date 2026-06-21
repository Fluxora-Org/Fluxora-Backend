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

Each cache write stores a small metadata envelope next to the response value: write time, expiry time, configured TTL, and the last refresh duration. Readers remain compatible with older raw JSON entries, but only envelope entries can participate in early refresh.

Cache keys use fixed operation names. Parameterized calls, such as account existence checks, include a SHA-256 hash of the parameter rather than raw account data. This prevents key injection, keeps key length bounded, and avoids writing account identifiers into Redis keys.

When the circuit is `CLOSED`, the fallback cache can smooth hot-key TTL boundaries with XFetch-style probabilistic early expiry. If an entry is close enough to expiry, one request starts a background refresh while the current request still receives the cached value. Concurrent callers keep receiving the cached value and do not all stampede the Stellar RPC provider.

The early-expiry beta factor is controlled by `RPC_FALLBACK_CACHE_EARLY_EXPIRY_BETA`:

- Default: `0` (disabled).
- Set a positive value, such as `1`, to enable closed-circuit cache reads and early refresh.
- Larger values refresh earlier and more aggressively.

When the circuit is `OPEN`:

1. A cache hit returns the stale last-known-good response and increments `rpc_circuit_open_fallback_hits_total`.
2. A cache miss increments `rpc_circuit_open_fallback_misses_total` and propagates `CircuitOpenError`.
3. HTTP requests executed through `rpcDegradationMiddleware` include `X-RPC-Cache: stale` when a stale RPC response was used.

Closed-circuit cache behavior emits:

- `rpc_fallback_cache_hits_total`
- `rpc_fallback_cache_misses_total`
- `rpc_fallback_cache_early_refreshes_total`

Redis cache read/write failures are logged as warnings and treated as misses or no-op writes. The fallback cache must not become a hard dependency for normal RPC calls.

## Security Notes

- Cached values are JSON only and are parsed with `JSON.parse`; no dynamic code execution is used.
- Raw account addresses are URL-encoded for Horizon requests and hashed before use in Redis cache keys.
- Redis credentials come from environment configuration and are never logged.
- Stale fallback responses are served only while the circuit breaker is `OPEN`; `HALF_OPEN` uses live probe calls.
