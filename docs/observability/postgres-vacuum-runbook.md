# Postgres VACUUM Monitoring — Operations Runbook

## Overview

Long-running write workloads on `streams`, `contract_events`, `audit_logs`, and `webhook_outbox` accumulate dead tuples that bloat tables and degrade query performance. The vacuum collector in `src/metrics/vacuumCollector.ts` queries `pg_stat_user_tables` every 60 seconds and exposes three prom-client Gauges for operator alerting.

---

## Exposed metrics

| Metric name | Labels | Description |
|---|---|---|
| `fluxora_pg_dead_tuples` | `table` | Raw dead tuple count (`n_dead_tup`) |
| `fluxora_pg_bloat_ratio` | `table` | `n_dead_tup / (n_live_tup + n_dead_tup)` — 0.0 to 1.0 |
| `fluxora_pg_last_autovacuum_age_seconds` | `table` | Seconds since the last autovacuum; `-1` if autovacuum has never run |

Monitored tables: `streams`, `contract_events`, `audit_logs`, `webhook_outbox`.

---

## Prometheus alert rules

```yaml
groups:
  - name: postgres_vacuum
    rules:

      - alert: HighTableBloat
        expr: fluxora_pg_bloat_ratio > 0.20
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Table {{ $labels.table }} bloat ratio exceeds 20%"
          description: >
            Dead tuples on {{ $labels.table }} make up {{ $value | humanizePercentage }}
            of total tuple count. Run VACUUM ANALYZE {{ $labels.table }};

      - alert: CriticalTableBloat
        expr: fluxora_pg_bloat_ratio > 0.40
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Table {{ $labels.table }} bloat ratio exceeds 40%"
          description: >
            Autovacuum may be failing or unable to keep up. Immediate manual
            VACUUM required. Check pg_stat_activity for long-running transactions
            blocking autovacuum.

      - alert: AutovacuumStalled
        expr: fluxora_pg_last_autovacuum_age_seconds > 86400
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Autovacuum has not run on {{ $labels.table }} in more than 24 hours"
          description: >
            Last autovacuum on {{ $labels.table }} ran
            {{ $value | humanizeDuration }} ago. Check autovacuum configuration
            and pg_stat_activity for blocking transactions.

      - alert: TableNeverVacuumed
        expr: fluxora_pg_last_autovacuum_age_seconds == -1
        for: 30m
        labels:
          severity: info
        annotations:
          summary: "Table {{ $labels.table }} has never been autovacuumed"
          description: >
            Consider running VACUUM ANALYZE {{ $labels.table }}; manually or
            verifying autovacuum is enabled for this table.

      - alert: HighDeadTupleCount
        expr: fluxora_pg_dead_tuples > 500000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Table {{ $labels.table }} has more than 500,000 dead tuples"
          description: >
            Dead tuple accumulation may indicate a long-running transaction or
            autovacuum misconfiguration.
```

---

## Recommended thresholds

| Condition | Threshold | Action |
|---|---|---|
| Bloat ratio | > 20% | Monitor; consider manual VACUUM |
| Bloat ratio | > 40% | Immediate manual VACUUM ANALYZE |
| Autovacuum age | > 24 hours | Investigate blocking transactions |
| Dead tuple count | > 500,000 | Investigate autovacuum scale factor settings |
| Never vacuumed | age = -1 | Run manual VACUUM ANALYZE |

---

## Remediation steps

### 1. Check autovacuum activity

```sql
SELECT pid, query, state, now() - query_start AS duration
FROM pg_stat_activity
WHERE query ILIKE 'autovacuum%'
ORDER BY duration DESC;
```

### 2. Check for long-running transactions blocking VACUUM

```sql
SELECT pid, usename, state, now() - xact_start AS txn_age, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY txn_age DESC
LIMIT 10;
```

Transactions older than the autovacuum freeze threshold prevent dead tuple reclamation. Terminate if safe:

```sql
SELECT pg_terminate_backend(<pid>);
```

### 3. Manual VACUUM on a specific table

```sql
-- Standard vacuum (reclaims space, updates statistics)
VACUUM ANALYZE streams;

-- Full vacuum (rewrites table, reclaims space to OS — locks table)
-- Only use during maintenance window
VACUUM FULL ANALYZE streams;
```

### 4. Tune autovacuum for high-write tables

For tables that accumulate dead tuples faster than the global autovacuum settings allow, override per-table:

```sql
ALTER TABLE streams SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- trigger at 1% dead tuples (default 20%)
  autovacuum_analyze_scale_factor = 0.005, -- trigger analyze at 0.5% new rows
  autovacuum_vacuum_cost_delay = 2         -- ms (default 2ms; lower = faster vacuum)
);
```

Apply the same settings to `contract_events`, `audit_logs`, and `webhook_outbox` as needed.

For `contract_events`, prefer targeting the hot ledger partition when the parent
table is partitioned:

```sql
VACUUM ANALYZE contract_events_ledger_1000000_1100000;
```

If bloat is concentrated in old closed ranges, run the retention helper in
dry-run mode first and detach old partitions only after backup verification.
Permanent drops require an explicit backup confirmation in the ops helper.

### 5. Check current autovacuum settings for a table

```sql
SELECT relname, reloptions
FROM pg_class
WHERE relname IN ('streams', 'contract_events', 'audit_logs', 'webhook_outbox');
```

### 6. Review contract event partitions

```sql
SELECT
  child.relname AS partition_name,
  pg_get_expr(child.relpartbound, child.oid) AS bounds,
  child.reltuples::bigint AS estimated_rows
FROM pg_inherits
JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
JOIN pg_class child ON child.oid = pg_inherits.inhrelid
WHERE parent.relname = 'contract_events'
ORDER BY partition_name;
```

Create the next partition before replay crosses a ledger boundary:

```sql
SELECT ensure_contract_events_partition(1100000, 1200000);
```

Use `enforceContractEventsRetention()` from `src/scripts/db-ops.ts` for
retention. The default is dry-run/off; live detach requires `confirm: true`.
Use `mode: "drop"` only after S3 or snapshot backup verification and
`backupConfirmed: true`.

---

## Collector internals

The collector is started during app startup in `src/app.ts` when a `pool` option is passed to `createApp`:

```typescript
const app = createApp({ pool: getPool() });
// app.locals.vacuumInterval holds the NodeJS.Timeout handle
```

To stop the collector during graceful shutdown:

```typescript
if (app.locals.vacuumInterval) {
  clearInterval(app.locals.vacuumInterval);
}
```

The collector silently absorbs DB errors (logged as warnings) so a transient connection failure does not affect the metrics collection loop or the application itself.

---

## Grafana dashboard queries

```promql
# Dead tuples per table
fluxora_pg_dead_tuples{job="fluxora"}

# Bloat ratio as percentage
fluxora_pg_bloat_ratio{job="fluxora"} * 100

# Hours since last autovacuum
fluxora_pg_last_autovacuum_age_seconds{job="fluxora"} / 3600
```
