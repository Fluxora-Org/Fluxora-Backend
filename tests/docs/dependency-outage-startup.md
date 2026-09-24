# Dependency Outage Startup Behaviour

Fluxora-Backend uses tiered startup dependency probing.

## Postgres

Postgres is a hard dependency.

If Postgres is unavailable when the service starts:

* The startup probe fails immediately.
* A structured fatal startup-probe event is logged.
* The process exits instead of starting without its critical database dependency.

The service should therefore be restarted by the process supervisor or orchestrator rather than remaining in a running-but-unusable state.

## Redis

Redis is a soft dependency.

If Redis is unavailable when the service starts:

* The service retries the connection using bounded backoff.
* If Redis remains unavailable after the startup probe budget is exhausted, startup continues.
* Redis is reported as `degraded`.
* The service remains available for functionality that does not require Redis.

Readiness reflects the degraded dependency state.

## Stellar RPC

Stellar RPC is also a soft dependency.

If the RPC endpoint is unavailable when the service starts:

* The service retries the connection using bounded backoff.
* If the dependency remains unavailable after the startup probe budget is exhausted, startup continues.
* Stellar RPC is reported as `degraded`.
* Readiness reflects the missing dependency.

## Recovery

Soft dependencies are checked again after startup through the normal health-check mechanism.

When an unavailable dependency becomes healthy again, its health state is updated automatically and readiness can return to `healthy`.

## Expected readiness states

| Dependency state        | Startup behaviour      | Readiness                                        |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| Postgres unavailable    | Fail startup           | Process exits                                    |
| Redis unavailable       | Start in degraded mode | Degraded/unhealthy readiness                     |
| Stellar RPC unavailable | Start in degraded mode | Degraded/unhealthy readiness                     |
| Dependency recovers     | Continue running       | Returns to healthy when all dependencies recover |
