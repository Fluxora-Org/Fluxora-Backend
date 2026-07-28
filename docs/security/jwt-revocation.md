# JWT Revocation (Blocklist)

## Overview

JWT tokens issued by the Fluxora auth flow are valid until their `exp` claim. To support immediate invalidation — for logout, key compromise, or admin action — a Redis-backed revocation list (blocklist) is maintained and checked on every authenticated request.

## Architecture
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Client    │────▶│  POST /session  │────▶│  JWT issued │
└─────────────┘     └─────────────────┘     └─────────────┘
│
▼
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Client    │────▶│  Authenticated  │────▶│ isRevoked?  │
└─────────────┘     │     Request     │     └─────────────┘
└─────────────────┘           │
│                       │
▼                       ▼
┌─────────────┐         ┌─────────────┐
│  Signature  │         │   Redis     │
│   verify    │         │  EXISTS jti │
└─────────────┘         └─────────────┘


## Flow

1. **Token issuance** (`POST /api/auth/session`): JWT is signed with `jti` claim
2. **Token use**: Client sends `Authorization: Bearer <token>`
3. **Authentication middleware** (`src/middleware/auth.ts`):
   - Verify signature (cryptographic integrity)
   - Check `isRevoked(jti)` in Redis (immediate invalidation)
   - Validate schema (shape enforcement)
4. **Token revocation** (`POST /api/auth/revoke`): Admin adds `jti` to Redis blocklist

## Redis Schema

| Key | Type | TTL | Value |
|-----|------|-----|-------|
| `jwt:revoked:<jti>` | String | 7 days (configurable) | `"1"` |

- **Key format**: `jwt:revoked:<jti>`
- **Lookup**: `EXISTS jwt:revoked:<jti>` — O(1) complexity
- **Cleanup**: Redis TTL auto-expires entries; no manual sweeps needed

## API

### `POST /api/auth/revoke` (Admin-only)

Revoke a JWT before its natural expiry.

**Request:**
```json
{
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "ttl": 86400
}

{
  "success": true,
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "ttl": 86400
}

Errors:
400 — Invalid jti or TTL
401 — Missing or invalid authentication
403 — Insufficient permissions (admin only)

src/redis/jwtRevocationStore.ts
// Revoke a token
await revoke(jti, ttlSeconds);

// Check if revoked
const revoked = await isRevoked(jti);
if (revoked) { /* reject */ }

Security Properties
| Property                   | Implementation                                                  |
| -------------------------- | --------------------------------------------------------------- |
| **Immediate invalidation** | Redis `SET` with `EX` — effective immediately                   |
| **Fail-closed**            | Redis unavailable → treat as revoked (safety over availability) |
| **Idempotent revocation**  | Duplicate `revoke()` calls overwrite safely                     |
| **Auto-cleanup**           | Redis TTL prevents unbounded growth                             |
| **Audit logging**          | All revocations logged with jti, TTL, and admin address         |


Fail-Closed vs. Fail-Open
The system uses fail-closed behavior: if Redis is unavailable, isRevoked() returns true and rejects the token.
Rationale:
Security: Prevents compromised tokens from being accepted during an outage
Trade-off: Reduced availability during Redis downtime
Mitigation: Redis retry strategy (3 retries, exponential backoff) reduces transient failures


Testing
# Unit tests
pnpm test tests/unit/redis/jwtRevocationStore.test.ts
pnpm test tests/unit/middleware/auth.test.ts

# Coverage
pnpm test:coverage

Configuration
| Env Var          | Default     | Description           |
| ---------------- | ----------- | --------------------- |
| `REDIS_HOST`     | `localhost` | Redis server hostname |
| `REDIS_PORT`     | `6379`      | Redis server port     |
| `REDIS_PASSWORD` | —           | Redis auth password   |
| `REDIS_DB`       | `0`         | Redis database number |


Migration Notes
Backward compatible: Tokens without jti skip revocation check (existing tokens continue to work)
No storage changes: Revocation list is external to application database
Graceful degradation: Redis connection failures are handled with fail-closed logic

