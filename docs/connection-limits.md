# Connection and statement limits

Fluxora talks to three external dependencies: PostgreSQL (a primary pool and an
optional read-replica pool), Redis, and the Stellar/Soroban RPC endpoint. Each
applies connection-pool sizes, acquisition timeouts, statement timeouts and
retry budgets. This page is the single place those values are collected, so the
combined worst case can be reasoned about without reading four modules.

Every limit below is declared in `EnvSchema` (`src/config/env.ts`) and applied
by the module named in the last column. The table is not decorative:
`src/config/connectionLimits.test.ts` parses it and fails if a documented
default drifts from the configuration schema, or if a limit declared in the
schema is missing from this page.

## Limits

| Variable | Default | Unit | Dependency | Where / what it bounds |
| --- | --- | --- | --- | --- |
| `DB_POOL_MIN` | `2` | connections | PostgreSQL (primary) | `src/db/pool.ts` — minimum idle connections kept open. |
| `DB_POOL_MAX` | `10` | connections | PostgreSQL (primary) | `src/db/pool.ts` — hard cap on pool connections. |
| `DB_CONNECTION_TIMEOUT` | `5000` | ms | PostgreSQL (primary) | `src/db/pool.ts` — time to wait for a pooled connection before failing. |
| `DB_IDLE_TIMEOUT` | `30000` | ms | PostgreSQL (primary) | `src/db/pool.ts` — time an idle pooled connection is kept before it is closed. |
| `POOL_QUEUE_LIMIT` | `50` | requests | PostgreSQL (primary) | `src/db/pool.ts` — waiting requests allowed before the pool fast-fails with `503`. |
| `STATEMENT_TIMEOUT_MS` | `5000` | ms | PostgreSQL (primary) | `src/db/pool.ts` — per-connection `statement_timeout`; `0` disables. |
| `REPLICA_QUEUE_LIMIT` | `25` | requests | PostgreSQL (replica) | `src/db/replicaPool.ts` — waiting requests allowed before the replica pool fast-fails. |
| `REDIS_CONNECT_TIMEOUT_MS` | `5000` | ms | Redis | `src/redis/client.ts` — TCP connect timeout for each Redis client. |
| `REDIS_MAX_RETRIES_PER_REQUEST` | `3` | requests | Redis | `src/redis/client.ts` — command retries per request before a call fails. |
| `REDIS_RETRY_BASE_DELAY_MS` | `50` | ms | Redis | `src/redis/client.ts` — base delay of the reconnect backoff. |
| `REDIS_RETRY_MAX_DELAY_MS` | `2000` | ms | Redis | `src/redis/client.ts` — ceiling of the reconnect backoff. |
| `REDIS_RETRY_MAX_ATTEMPTS` | `10` | requests | Redis | `src/redis/client.ts` — reconnect attempts before ioredis stops retrying. |
| `STELLAR_RPC_TIMEOUT` | `10000` | ms | Stellar RPC | `src/config.ts` — timeout for the legacy RPC client. |
| `STELLAR_RPC_MAX_RETRIES` | `3` | requests | Stellar RPC | `src/services/stellar-rpc.ts` — retries for a failed RPC call. |
| `STELLAR_RPC_RETRY_DELAY` | `1000` | ms | Stellar RPC | `src/services/stellar-rpc.ts` — base delay between RPC retries. |
| `RPC_TIMEOUT_MS` | `5000` | ms | Stellar RPC | `src/services/stellar-rpc.ts` — per-call timeout for the RPC service. |
| `RPC_CB_FAILURE_THRESHOLD` | `5` | failures | Stellar RPC | `src/services/stellar-rpc.ts` — consecutive failures that trip the circuit breaker. |
| `RPC_CB_WINDOW_MS` | `30000` | ms | Stellar RPC | `src/services/stellar-rpc.ts` — window over which RPC failures are counted. |
| `RPC_CB_RESET_TIMEOUT_MS` | `60000` | ms | Stellar RPC | `src/services/stellar-rpc.ts` — time the breaker stays open before probing. |

## Combined worst-case connection count

The two PostgreSQL pools are the only resources that hold a fixed, configured
number of sockets. With the defaults above:

```
primary pool            DB_POOL_MAX = 10
replica pool            DB_POOL_MAX = 10   (only when DATABASE_REPLICA_URL is set)
--------------------------------------------
total                   20 pooled connections per backend instance
```

**Combined worst-case pooled database connections: 20.**

The replica pool is created lazily and only when `DATABASE_REPLICA_URL` is set,
so a deployment without a replica holds at most `DB_POOL_MAX` = 10 pooled
connections. `POOL_QUEUE_LIMIT` and `REPLICA_QUEUE_LIMIT` bound *waiting
requests*, not connections: a full pool with an empty queue is healthy, and the
queue is what fast-fails with `503` once saturated.

The other two dependencies are deliberately excluded from that number:

- **Redis** is not pooled. Each `createRedisClient` call opens one multiplexed
  ioredis connection, so the socket count is bounded by the number of subsystems
  that enable Redis, not by a pool size. In `cluster`/`sentinel` mode ioredis
  additionally opens one connection per discovered node.
- **Stellar RPC** holds no persistent socket. Each call is an HTTP request
  bounded by `RPC_TIMEOUT_MS`, retried up to `STELLAR_RPC_MAX_RETRIES` times
  with a `STELLAR_RPC_RETRY_DELAY`-based backoff, and shed by the circuit
  breaker (`RPC_CB_*`) when the provider is unhealthy.

## Limits without a fixed default

Two limits are documented here but cannot be expressed as a constant, so they
are intentionally absent from the table above:

- `REPLICA_STATEMENT_TIMEOUT_MS` — optional; when unset the replica pool inherits
  `STATEMENT_TIMEOUT_MS` (default `5000` ms). `src/db/replicaPool.ts`.
- `STELLAR_RPC_OPERATION_DEADLINES` — optional JSON object mapping operation
  names to per-operation timeouts in ms; a listed operation overrides
  `RPC_TIMEOUT_MS` for that call. `src/services/stellar-rpc.ts`.

## Enforcement

`src/config/connectionLimits.ts` holds the defaults used by `EnvSchema` and the
registry of every limit that must appear on this page. The accompanying test,
`src/config/connectionLimits.test.ts`, asserts that:

1. every documented default equals the default declared in `EnvSchema`;
2. every limit in the schema appears in the table above, so nothing is added to
   the configuration without being documented here;
3. the combined worst-case count is consistent with `DB_POOL_MAX`.
