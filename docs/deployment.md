# Canary Routing Deployment

## Overview
The **canary routing middleware** enables a deterministic, percentage-based traffic split for canary deployments. It tags a configurable portion of requests as canary by computing a stable hash of the client identity (API key or IP address) combined with a dedicated salt. This ensures:

- **Deterministic routing**: The same client always lands in the same bucket for the lifetime of a deployment.
- **Independence from feature flags**: Uses its own salt (`CANARY_SALT`) to avoid correlation with feature-flag rollout hashes.
- **Graceful degradation**: Clients without determinable identity are skipped without error.
- **End-to-end traceability**: Canary decisions are logged with the request's correlation ID, making them traceable through the structured logging pipeline.

## Configuration

| Variable | Description | Default | Range |
|----------|-------------|---------|-------|
| `CANARY_TRAFFIC_PERCENT` | Percentage of requests to tag as canary (0–100). | `0` | 0–100 |
| `CANARY_SALT` | Salt to isolate canary hashing from other rollout mechanisms. | `canary-routing-v1` | Arbitrary string |

### Environment Setup
```bash
# Enable 10% canary traffic
export CANARY_TRAFFIC_PERCENT=10

# Use a custom salt (recommended for multi‑tenant or multi‑experiment setups)
export CANARY_SALT="my‑team‑canary‑v2"
```

The middleware reads these values at request time via `loadConfig()` so they can be changed without restarting the process (provided the process handles hot‑reloaded configuration).

## How It Works

1. **Identity Resolution**  
   - Preference order: `X-API-Key` header → `req.ip` (Express‑resolved, respects `trust proxy`).  
   - If neither is present, the request is not tagged as canary.

2. **Hashing**  
   - Computes `SHA‑256(CANARY_SALT + ':' + clientIdentity)`.  
   - Takes the first 8 hex characters of the digest, interprets as a uint32.  
   - Maps to a bucket in `[0, 100)` via modulo operation.

3. **Decision**  
   - If `bucket < CANARY_TRAFFIC_PERCENT`, the request is marked as canary (`req.isCanary = true`).  
   - A response header `X-Fluxora-Canary: true` is added for canary requests.

4. **Logging**  
   - Debug‑level logs include the correlation ID, bucket number, and traffic percent when a request is tagged as canary.

## Integration Points

- **Correlation ID**: Must run **after** `correlationIdMiddleware` so `req.correlationId` is available.
- **Placement in middleware stack**: Typically placed early, after correlation ID and before business logic handlers.
- **Express compatibility**: Works with any Express app; no special routing requirements.

## Security Considerations

- **Identity Privacy**: Raw client IP and API keys are never logged; only the derived bucket decision is logged.
- **Salt Protection**: `CANARY_SALT` is stored in environment variables and never written to logs or response bodies.
- **Header Injection**: The middleware sanitizes the `X-Fluxora-Canary` header value (`true`) to prevent header injection attacks.
- **Rate Limiting**: Because the decision is deterministic, canary traffic can be rate‑limited using standard IP‑based or API‑key‑based limits without risk of uneven distribution.

## Testing

The existing test suite (`tests/middleware/canaryRouting.test.ts`) covers:

- Deterministic bucket calculation (`computeCanaryBucket`).
- Identity resolution (`resolveClientIdentity`).
- Middleware behavior for enabled/disabled traffic, header echo, and `req.isCanary` setting.
- Environment variable overrides for traffic percent and salt.
- Correlation‑ID integration.
- Security checks (no raw secrets logged).

Run tests with:

```bash
npx vitest run
```

## NatSpec Documentation (Source)

The middleware includes full NatSpec‑style comments that describe each public API:

- `computeCanaryBucket(salt, identity, modulus)` – core hashing logic.
- `resolveClientIdentity(req)` – identity selection rules.
- `createCanaryRoutingMiddleware(options)` – middleware factory.
- `canaryRoutingMiddleware` – pre‑configured middleware instance.

These comments are parsed by documentation generators and provide inline guidance for developers and operators.

## Deployment Checklist

- [ ] `CANARY_TRAFFIC_PERCENT` set appropriately in the environment for the target deployment.
- [ ] `CANARY_SALT` set to a value that distinguishes this canary effort from other rollouts.
- [ ] Verify that `correlationIdMiddleware` is mounted **before** the canary middleware.
- [ ] Confirm that logs include `canary-routing` debug entries for canary‑tagged requests.
- [ ] Run the middleware test suite in CI to ensure no regressions.
- [ ] Document the chosen salt and traffic percent in release notes or runbooks.

## See Also

- `src/middleware/correlationId.ts` – request correlation ID handling.
- `src/middleware/httpMetrics.ts` – metrics instrumentation for canary traffic.
- Feature flag rollout patterns – keep canary and feature‑flag spaces independent.