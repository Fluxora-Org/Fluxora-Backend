# WebSocket Connection Rate Limiting

This document outlines the security measures implemented to protect the Fluxora WebSocket service from connection-based denial-of-service (DoS) attacks and abuse.

## Overview

To ensure service stability and fair usage, the WebSocket hub implements a connection limiter that tracks active connections per client IP address and enforces thresholds for new connection attempts.

## Thresholds

The following environment variables control the connection limiting behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_MAX_CONNECTIONS_PER_IP` | `10` | Maximum number of concurrent WebSocket connections allowed from a single IP. |
| `WS_ABUSE_THRESHOLD` | `5` | Number of rejected connection attempts allowed within a sliding window before an IP is banned. |
| `WS_BAN_TTL_S` | `3600` | Duration (in seconds) for which an IP is banned after triggering the abuse threshold. |

## Connection Rejection

When a client attempts to open a connection that exceeds `WS_MAX_CONNECTIONS_PER_IP`, the server will:

1.  Accept the WebSocket upgrade handshake.
2.  Immediately close the connection with close code `4029`.
3.  Provide the reason "Too many connections" in the close frame.

## Abuse Detection and Banning

A sliding window (defaulting to 1 minute) tracks rejections per IP. If an IP triggers more than `WS_ABUSE_THRESHOLD` rejections within this window, it is temporarily banned.

During the ban period (`WS_BAN_TTL_S`):
- All new connection attempts from the banned IP are rejected with close code `4029`.
- The close reason will be "IP banned due to abuse".

## IP Spoofing Mitigation

To prevent IP spoofing, the connection limiter only trusts the `X-Forwarded-For` header if the request originates from a known proxy.

### Configuration

Trusted proxies must be configured via the `WS_TRUSTED_PROXIES` environment variable as a comma-separated list of IP addresses.

```env
WS_TRUSTED_PROXIES=127.0.0.1,10.0.0.1
```

If `WS_TRUSTED_PROXIES` is not set or the remote address is not in the list, the server uses the raw socket remote address and ignores any `X-Forwarded-For` headers.

## Ban store outage policy

The WebSocket ban store (`src/redis/banStore.ts`, `HybridBanStore`) **fails closed** during a Redis outage using a local in-memory read-through cache and fallback, so banning is never disabled when Redis is unavailable:

- `ban()` records the ban in the local cache **before** contacting Redis, so even if the Redis write fails the IP is rejected on that instance.
- `isBanned()` checks the local cache first, so a ban recorded on the instance (or the read-through cache from Redis) keeps denying during the outage.
- Rationale: accepting a banned abusive IP is a security failure (rule 1/4 of the governing outage-policy rule).

Trade-off: a ban created during an outage is only enforced locally until Redis returns, so it may not be visible across other instances/cluster replicas for the duration of the outage.

> Governing rule for all Redis outages:
> [`docs/security/redis-outage-policy.md`](./redis-outage-policy.md).
