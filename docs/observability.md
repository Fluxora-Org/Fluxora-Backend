# Observability

## Webhook Circuit Breaker Metrics

We track state transitions for webhook circuit breakers to provide visibility into consumer endpoint health.

### `fluxora_webhook_circuit_breaker_transitions_total`

A Prometheus counter tracking state transitions (`closed`, `open`, `half-open`).

Labels:
- `from_state`: The previous state.
- `to_state`: The new state.
- `consumer_hash`: SHA256 hash of the consumer URL, truncated to 16 characters, to ensure bounded cardinality.
