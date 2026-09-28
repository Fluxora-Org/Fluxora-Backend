# Client IP Extraction & Forwarding Header Security

This document outlines the security architecture and extraction rules used by Fluxora to determine the client IP address (`src/lib/ipExtraction.ts`).

## Overview

The client IP address feeds into critical security controls across the service:
- **HTTP Rate Limiting** (`src/middleware/rateLimiter.ts`): Enforcing per-IP request quotas.
- **Authentication Lockout** (`src/middleware/authLockout.ts`, `src/routes/auth.ts`): Locking out abusive IPs after repeated authentication failures.
- **WebSocket Connection Limiting & Banning** (`src/ws/connectionLimiter.ts`, `src/ws/hub.ts`): Banning abusive peers after connection flood rejections.
- **Audit Logging** (`src/lib/auditLog.ts`): Recording client attribution for sensitive actions.

If forwarding headers (such as `X-Forwarded-For`) are trusted naively without accounting for proxy topology, an attacker can supply arbitrary addresses in headers to evade rate limits/lockouts or attribute malicious requests to victim addresses.

## Extraction Rules

Fluxora enforces strict, topology-aware client IP extraction:

1. **Direct / Untrusted Connections (Default)**
   - When no trusted proxy configuration (`TRUSTED_PROXY_COUNT` or `TRUSTED_PROXIES`) is provided, or when `RATE_LIMIT_TRUST_PROXY=false`, forwarding headers are **never trusted**.
   - The server directly uses `socket.remoteAddress`.

2. **Trusted Hop Count (`TRUSTED_PROXY_COUNT` / `TRUST_PROXY_HOPS`)**
   - Configured when the exact number $N$ of reverse proxy hops in front of the application is known (e.g. `TRUSTED_PROXY_COUNT=1` for a single reverse proxy like ALB or Nginx).
   - The application inspects the `X-Forwarded-For` header list from right to left (most recent to oldest) and extracts the $N$-th hop from the right:
     $$\text{Client IP} = \text{ips}[\text{ips.length} - N]$$
   - Any forwarding entries to the left of the $N$-th entry are beyond the trusted hop count and are ignored. Prepending forged IPs in `X-Forwarded-For` cannot alter the extracted client IP.
   - If an optional `TRUSTED_PROXIES` address list is also specified, the direct socket connection must match an IP in that list; otherwise the socket `remoteAddress` is used.

3. **Trusted Proxy Address List (`TRUSTED_PROXIES` / `WS_TRUSTED_PROXIES`)**
   - Configured as a comma-separated list of known proxy IP addresses (e.g., `127.0.0.1, 10.0.0.1`).
   - If the direct socket `remoteAddress` is not in `TRUSTED_PROXIES`, `X-Forwarded-For` is ignored and `remoteAddress` is returned.
   - If `remoteAddress` is trusted, the application traverses `X-Forwarded-For` from right to left (from most recent proxy to oldest).
   - The first IP encountered in the reverse traversal that is **not** in `TRUSTED_PROXIES` is the authentic client address.
   - Upstream client-forged headers appearing before this hop are ignored.

## Configuration Reference

| Variable | Type | Default | Description |
|---|---|---|---|
| `RATE_LIMIT_TRUST_PROXY` | boolean | `true` | Master toggle. Setting to `false` disables all forwarding header trust. |
| `TRUSTED_PROXY_COUNT` | integer | `0` | Number of trusted reverse proxy hops in front of the application. |
| `TRUSTED_PROXIES` | comma-separated IPs | unset | IP addresses of trusted reverse proxies. |
| `WS_TRUSTED_PROXIES` | comma-separated IPs | unset | Alias / backward-compatible list of trusted proxy IPs. |

## Normalization & Dual-Stack Support

All IP address matching normalizes IPv4-mapped IPv6 representations (e.g. `::ffff:127.0.0.1` is normalized to `127.0.0.1`), ensuring consistent policy enforcement across dual-stack network interfaces.
