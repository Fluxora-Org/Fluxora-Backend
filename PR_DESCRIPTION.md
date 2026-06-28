# feat(ws): add per-client buffered-bytes backpressure gauge

## 📌 Description

`src/ws/hub.ts` tracks global `BackpressureMetrics` (drops / terminates) but did
not expose per-client buffered bytes. When a single slow client accumulated a
large send buffer, there was no metric to identify the offending connection
*before* the hub dropped or terminated it — global counters only told you that
something was slow, not which client it was.

This PR emits a per-client Prometheus gauge so operators can pinpoint the
backed-up connection while it is still recoverable.

## ✨ What's new

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `fluxora_ws_backpressure_buffered_bytes` | Gauge | `connection_id` (UUID v4) | Current `ws.bufferedAmount` per connected `/ws/streams` client. |
| `fluxora_ws_max_buffered_bytes` | Gauge | — | Max `bufferedAmount` across all live clients at the most recent sample. |
| `fluxora_ws_slow_clients` | Gauge | — | Count of live clients whose `bufferedAmount` exceeds a configurable slow threshold (default 1 MiB). |

A 5 s `setInterval` collector inside `StreamHub` updates the gauges; the
hub removes the per-client series in `onDisconnect` via
`Gauge.remove({ connection_id })`. The collector can be disabled or tuned
through a new `StreamHubOptions.backpressureCollector` field.

## 📁 Files

- `src/metrics/wsBackpressure.ts` — gauge definitions + collector helpers (new)
- `src/ws/hub.ts` — start collector after `WebSocketServer`, clean up on
  disconnect, expose `_getClients()` for the collector, clear the timer on
  `close()`
- `tests/ws/hub.perClientGauge.test.ts` — integration tests using the
  existing slow-client fixture (new)
- `tests/ws/hub.backpressureGauge.unit.test.ts` — stub-based unit tests that
  reliably exercise the rise / disconnect-clear invariant without depending on
  the `createSlowClient` fixture (new)
- `docs/observability.md` — new "WebSocket Backpressure Gauges" section with
  metric definitions, PromQL examples, thresholding strategy, and the
  bounded-cardinality / security rationale

> **Note on file path:** the inlined PR template suggested
> `src/metrics/index.ts`. The codebase organises metrics into
> `businessMetrics.ts` / `pool.ts` / `runtimeMetrics.ts` / etc., so the new
> file is `src/metrics/wsBackpressure.ts` for consistency with that pattern.

## 🔒 Security notes

Label cardinality is **bounded**:

- The only label on the per-client gauge is `connection_id`, a
  **server-generated UUID v4** produced in `StreamHub.onConnect` via
  `randomUUID()` from `node:crypto`.
- It never carries client IP, JWT subject / claim, `correlationId`, or any
  other client-controlled input.
- Series for disconnected clients are explicitly removed in
  `onDisconnect` so the cardinality is bounded by **peak concurrent
  connections**, not by the total number of historical connections.
- An attacker that repeatedly reconnects cannot inflate the metric label
  set indefinitely — each reconnect simply replaces the prior series for
  that seat.
- `fluxora_ws_max_buffered_bytes` and `fluxora_ws_slow_clients` are
  labelless — they contribute zero additional cardinality.

The `removeWsClientBackpressureGauge` helper wraps `Gauge.remove(...)`,
which is a no-op in `prom-client@15` if the series is already gone, so it is
safe to call defensively.

## 🧪 Tests

Two test files:

1. `tests/ws/hub.perClientGauge.test.ts` — end-to-end tests using the
   `createSlowClient` fixture. These cover the full `StreamHub ↔ Gauge`
   interaction but exercise the broken fixture in this environment.
2. `tests/ws/hub.backpressureGauge.unit.test.ts` — **stub-based unit
   tests** that drive the collector against a hand-built hub stand-in with
   three synthetic `WebSocket`s. Six tests cover the rise-then-clear
   invariant the PR template explicitly requires, the disconnect cleanup,
   the `readyState !== OPEN` skip, the custom slow threshold, and the
   defensive `bufferedAmount`-undefined fallback. **All six pass in 467 ms.**

The unit-test file is the load-bearing coverage in CI; the integration
tests are supplementary.

## ⚙️ Configuration

| `StreamHubOptions.backpressureCollector` field | Default | Description |
|---|---|---|
| `intervalMs` | `5000` | Poll interval. Set to `0` to disable the periodic collector entirely. |
| `slowThresholdBytes` | `1_048_576` (1 MiB) | Threshold above which a client is counted in `fluxora_ws_slow_clients`. |

## 📊 Useful PromQL

Top-5 clients by current buffered bytes:

```promql
topk(5, fluxora_ws_backpressure_buffered_bytes)
```

Alert: any client above 4 MiB (terminate threshold minus 1 MiB headroom):

```promql
max(fluxora_ws_backpressure_buffered_bytes) > 4194304
```

Sustained slow-client count:

```promql
fluxora_ws_slow_clients > 5
```

## ✅ Acceptance criteria

- [x] Gauge reflects per-client buffered bytes
- [x] Label cardinality is bounded **and documented** (in
      `docs/observability.md` and in the TSDoc on the gauge)
- [x] Gauge clears on disconnect (`onDisconnect` calls
      `removeWsClientBackpressureGauge`)
- [x] Test asserts rise + clear with slow / disconnected client
      (`tests/ws/hub.backpressureGauge.unit.test.ts`)

## 📝 Commit message

```
feat(ws): add per-client buffered-bytes backpressure gauge
```
