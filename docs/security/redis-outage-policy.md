# Redis Outage Policy for Security-Critical Stores

> **Authoritative decision rule.** Historically the security-critical Redis-backed
> stores each picked an outage policy in isolation — JWT revocation failed closed,
> the abuse-ban store failed closed via a local fallback, and the webhook pacing
> stores failed open — with no shared rationale for which policy is correct. This
> document is that rationale. Any Redis-backed store **must** derive its outage
> behaviour from the rule below and be listed in the table, or the behaviour is a
> defect.

## The decision rule

For every Redis operation, decide the outage behaviour from **the harm of a false
default when Redis cannot answer**. There are four rules, applied in order:

1. **Wrong-allow is a security hole → FAIL-CLOSED.**
   If defaulting the check outcome to "permitted / proceed" would admit something
   that must be denied, the store must treat an outage as *denied* and block. This
   is the operating failure model where the availability cost of rejecting good
   work is clearly smaller than the security cost of accepting a bad subject.

2. **Wrong-deny is the only harm and there is no authorization/abuse boundary →
   FAIL-OPEN (only as a deliberate, considered choice).**
   If defaulting to "blocked" merely stalls an availability-only activity and can
   never admit a dangerous subject, an outage may be allowed through — **but only
   if** it is an explicit decision surfaced in code and docs and observable, never
   an accidental `catch` that swallows the error.

3. **A state-changing write on a security gate that did not really happen →
   FAIL-LOUD.**
   A revocation, rotation, ban or similar action the operator *believes* persisted
   is worse than the operation itself failing. Surface such failures to the caller
   / operator (typed error or 5xx) rather than returning success.

4. **Everything else → local in-memory fallback is acceptable, but the fallback
   must not turn an authorization check into a false-allow.**
   It is fine to keep state locally, but a "deny / revocation" check must continue to
   deny on the instance (e.g. the read-through ban cache below) even while the
   cluster-wide source of truth is unreachable.

Rule 2 is the only one that permits fail-open, and it is a *labelled exception*,
not a free choice.

## Authoritative store table

| Store / operation | Outage behaviour | Rule | Rationale |
|---|---|---|---|
| JWT revocation — `isRevoked` (`src/redis/jwtRevocationStore.ts`) | **FAIL-CLOSED** → outage returns `true` (token rejected) | 1 | A false allow admits a revoked / compromised token. |
| JWT revocation — `revoke` (`src/redis/jwtRevocationStore.ts`) | **FAIL-LOUD** → throws `JwtRevocationError` | 3 | A revocation the operator thinks happened but did not persist is worse than an error. |
| WebSocket abuse ban — `HybridBanStore` (`src/redis/banStore.ts`) | **FAIL-CLOSED** via local in-memory read-through cache + fallback | 1 + 4 | A banned abusive IP must keep being rejected during an outage; the local cache keeps that instance rejecting. |
| Webhook retry rate limit — `checkLimit` (`src/redis/webhookRateLimit.ts`) | **FAIL-OPEN** → `canAttempt: true`, metric `fluxora_webhook_rate_limiter_fail_open_total` | 2 | Availability-only: dropping all deliveries is the only harm; there is no un-digest authorization boundary. |
| Webhook circuit breaker — `checkAndClaimAttempt` (`src/redis/webhookCircuitBreakerStore.ts`) | **FAIL-OPEN** → `allowed: true` | 2 | Availability-only: blocking all deliveries to a struggling consumer has no security upside. |

> The apparent "three different policies" are in fact the same rule applied to
> different grant models: JWT + bans (rule 1/3/4) *must* fail closed because a
> false allow is a security breach; webhook pacing + breaker (rule 2) *may* fail
> open because a detached delivery only loses availability. This is what makes each
> of the three policies correct for its store.

## When you add or change a Redis-backed store

1. Classify the operation (rules 1–4): would a false-allow admit something denied?
2. Add a row to the `authoritative store table` above documenting the classification.
3. Encode it in the store's error / `catch` path:
   - fail-closed → degrade to denied / local fallback; never silently return allow.
   - fail-open → only per rule 2, with a metric or explicit log.
   - fail-loud → throw / reject, never swallow a security-gate write (which == a JWT revocation, a ban).
4. Add a parallel line in `tests/security/redisOutagePolicy.test.ts` that drives a
   throwing Redis client and asserts the documented outage behaviour, so the
   implementation and this document cannot silently drift apart.

## Verification

- `tests/security/redisOutagePolicy.test.ts` asserts, per store in the table, the
  post-failure behaviour described here (fail-closed → denied; fail-open → allowed;
  fail-loud → throws).
- Per-store docs link here: `docs/security/jwt-revocation.md`,
  `docs/security/websocket-rate-limiting.md`, `docs/webhooks.md`.