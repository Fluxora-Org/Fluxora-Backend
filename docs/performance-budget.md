# Performance budget (hottest endpoints)

Machine-readable source of truth: [`k6/performance-budget.json`](../k6/performance-budget.json).

k6 thresholds in [`k6/config.js`](../k6/config.js) are generated from that file so a double-latency regression fails the load run. A Node gate ([`scripts/check-performance-budget.mjs`](../scripts/check-performance-budget.mjs)) evaluates comparable per-release summaries and exits non-zero when any endpoint exceeds its budget.

## Why

`tests/load` and `k6/` previously exercised hot paths without a recorded latency budget, so a change that doubled endpoint latency could still pass every CI gate. This budget closes that gap.

## Hot endpoints

| Id | Method | Path | Budget | Production observation (7d) |
| --- | --- | --- | --- | --- |
| `health` | GET | `/health` | p99 < 200 ms | p95 ≈ 35 ms, p99 ≈ 90 ms |
| `streams_list` | GET | `/api/streams` | p95 < 500 ms, p99 < 800 ms | p95 ≈ 180 ms, p99 ≈ 420 ms |
| `streams_get` | GET | `/api/streams/:id` | p95 < 400 ms, p99 < 700 ms | p95 ≈ 120 ms, p99 ≈ 310 ms |
| `streams_create` | POST | `/api/streams` | p95 < 600 ms, p99 < 1000 ms | p95 ≈ 260 ms, p99 ≈ 540 ms |

Global floors: overall `http_req_duration` p95 < 500 ms / p99 < 1000 ms, error rate < 1%.

Budgets were reviewed against production Prometheus histograms (`http_request_duration_seconds` by route) and staging k6 smoke baselines. Each budget is set above observed p99 with intentional headroom so real regressions fail while normal variance does not.

## Running the gate

```bash
# k6 smoke (thresholds come from the budget file; failure exits non-zero)
k6 run k6/main.js

# Evaluate a comparable summary artifact against the budget
node scripts/check-performance-budget.mjs --summary k6/results/performance-budget-summary.json

# Prove the gate fails when a hot path doubles latency
node scripts/check-performance-budget.mjs --fixture-regression
```

`k6 run k6/main.js` writes `k6/results/performance-budget-summary.json` via `handleSummary` so results stay comparable across releases (same endpoint ids and percentile columns).

The manually dispatched [Load tests workflow](../.github/workflows/load-tests.yml)
runs the selected profile against a deployed environment, fails when a threshold
is exceeded or an endpoint produces no percentile data, and retains the raw
metrics plus both summaries as a 90-day GitHub Actions artifact. Set the
`K6_API_KEY` repository secret when the target requires bearer authentication.

## Updating the budget

1. Re-measure production p95/p99 for each hot route.
2. Update `productionObservation` and `budgets` in `k6/performance-budget.json`.
3. Keep k6 thresholds derived from the JSON (do not hand-edit `THRESHOLDS` in isolation).
4. Record `reviewedAt` / `reviewedAgainst`.
