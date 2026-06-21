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
| `WS_HEARTBEAT_INTERVAL_MS` | `30000` | Interval between server ping control frames sent to connected clients. |
| `WS_HEARTBEAT_TIMEOUT_MS` | `60000` | Time a socket may wait for a pong response before the hub terminates it. |

## Heartbeat Reaping

The WebSocket hub sends periodic ping control frames to every connected client.
Each connection is marked alive when it is accepted and again whenever the
server receives a `pong` frame. If a socket does not answer the latest ping
within `WS_HEARTBEAT_TIMEOUT_MS`, the hub terminates it and runs the normal
disconnect cleanup path.

This cleanup path removes stream and recipient subscriptions and decrements the
per-IP connection count maintained by the limiter. As a result, half-open
connections behind proxies or firewalls cannot keep occupying an IP's
connection slots forever.

Heartbeat pongs are only liveness signals. They do not reset abuse-ban state,
increase rate limits, or let a banned IP bypass `WS_MAX_CONNECTIONS_PER_IP`.

```env
WS_HEARTBEAT_INTERVAL_MS=30000
WS_HEARTBEAT_TIMEOUT_MS=60000
```

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
