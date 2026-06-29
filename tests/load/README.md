# Fluxora Backend — Load Tests

This directory contains standalone k6 load-test scenarios that complement the
unit/integration test suite. Each scenario is self-contained and can be run
independently or as a group.

---

## Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) ≥ 0.50
- A running instance of the Fluxora Backend (see root `README.md`)

---

## Scenarios

### `idempotency-replay.js` — POST /api/streams idempotency replay

**Purpose**

Measures the throughput and latency difference between:

1. **Stage 1 (novel)** — 1 000 virtual users each sending a unique
   `Idempotency-Key` for the first time (cold path: DB write + Redis write).
2. **Stage 2 (replay)** — the same 1 000 VUs replaying the identical key
   (hot path: Redis cache hit only).

This matters because idempotency key replay is the hot path during network
retries. If replay is slower than novel requests, cascading retries can
overwhelm the system during incidents.

**Thresholds**

| Metric | Threshold |
|--------|-----------|
| Replay p99 latency | ≤ 50 ms |
| Novel p99 latency  | ≤ 1 000 ms |
| Error rate         | < 1 % |

**Running the scenario**

```bash
# Against local dev server (default)
k6 run tests/load/idempotency-replay.js

# Against a staging environment
k6 run -e K6_BASE_URL=https://staging.fluxora.io tests/load/idempotency-replay.js

# With authentication
k6 run \
  -e K6_BASE_URL=https://staging.fluxora.io \
  -e K6_API_KEY=<your-test-api-key> \
  tests/load/idempotency-replay.js

# Export raw metrics to InfluxDB for Grafana dashboards
k6 run --out influxdb=http://localhost:8086/k6 tests/load/idempotency-replay.js

# Export a CSV summary for CI artifact upload
k6 run --out csv=k6-raw.csv tests/load/idempotency-replay.js
```

The scenario also writes a human-readable CSV summary to
`tests/load/results-summary.csv` at the end of the run via `handleSummary`.
Upload this file as a CI artifact to track latency regressions over time.

**Environment variables**

| Variable      | Required | Default                  | Description                          |
|---------------|----------|--------------------------|--------------------------------------|
| `K6_BASE_URL` | No       | `http://localhost:3000`  | Base URL of the Fluxora Backend      |
| `K6_API_KEY`  | No       | *(empty — auth skipped)* | Bearer token; **never commit a real key** |

> **Security note:** Never hardcode `K6_API_KEY` in this script or in CI
> pipeline YAML in plaintext. Use your CI provider's secret store
> (GitHub Actions Secrets, GitLab CI/CD Variables, etc.).

**Stage design rationale**

```
Timeline (seconds)
 0 ──────────────── 35 ──────────────────────── 80
 |  Stage 1: novel  |                            |
 |  ramp 10s        |                            |
 |  hold 20s        |  Stage 2: replay           |
 |  ramp-down 5s    |  ramp 10s                  |
                    |  hold 30s                  |
                    |  ramp-down 5s              |
```

- `startTime: '35s'` on the replay scenario ensures Stage 1 has fully
  populated the Redis idempotency store before replays begin.
- VU-scoped keys (`idempotency-replay-vu-<VU_ID>`) are deterministic so that
  Stage 2 always replays the exact key seeded by Stage 1.

---

## CI integration example (GitHub Actions)

```yaml
- name: Run idempotency replay load test
  run: |
    k6 run \
      -e K6_BASE_URL=${{ secrets.STAGING_URL }} \
      -e K6_API_KEY=${{ secrets.STAGING_API_KEY }} \
      tests/load/idempotency-replay.js

- name: Upload load test summary
  uses: actions/upload-artifact@v4
  with:
    name: k6-idempotency-summary
    path: tests/load/results-summary.csv
```

---

## Existing k6 harness (`k6/`)

For the broader multi-scenario harness (health, streams CRUD, stress/soak
profiles), see [`k6/README`](../../k6/main.js) and run:

```bash
k6 run k6/main.js
k6 run -e PROFILE=load k6/main.js
```
