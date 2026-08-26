Description
src/webhooks/rate-limiter.ts currently appears to apply a flat rate limit to outbound webhook dispatch. Consumers with legitimately bursty event patterns (e.g. a batch of stream creations) can get needlessly throttled compared to a token-bucket approach with a small burst allowance.

Requirements
Introduce a token-bucket (or leaky-bucket) limiter with a configurable burst size layered on top of the steady-state rate, configurable via src/config/rateLimits.ts.
Preserve existing behavior when burst is set to 0/disabled for backward compatibility.
Expose the current bucket state via src/metrics/requestProtectionMetrics.ts for observability.
Suggested execution
Review the current limiter implementation and its config surface.
Implement the token-bucket variant behind a feature flag/config value.
Wire a new metric and add tests for burst-then-steady-state behavior.
Acceptance criteria

Burst allowance is configurable per deployment.

Steady-state rate is unaffected when burst is unused.

New metric exposes bucket fill level.
Security notes
Ensure the burst allowance cannot be abused to sustain a higher effective rate indefinitely (bucket must actually drain to the steady-state rate over time).

Guidelines
Minimum 95% test coverage
Timeframe: 96 hours
