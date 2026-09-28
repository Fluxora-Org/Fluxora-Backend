# Background Jobs Runbook

## Observability contract

Each recurring job exposes these Prometheus metrics, labeled by `job`:

- `fluxora_background_job_last_success_timestamp_seconds` - Unix timestamp of the last successful run.
- `fluxora_background_job_expected_interval_seconds` - Maximum expected interval between successful runs.
- `fluxora_background_job_stale` - `1` after the expected interval is exceeded, otherwise `0`.
- `fluxora_background_job_duration_seconds` - Run duration, labeled by `outcome` (`success` or `failure`).
- `fluxora_background_job_failures_total` - Count of failed runs.

The staleness gauge is evaluated during every Prometheus scrape, so a stopped worker is detected even when the application emits no new logs.

Recommended alert:

```yaml
- alert: FluxoraBackgroundJobStale
  expr: fluxora_background_job_stale == 1
  for: 5m
  severity: critical
  annotations:
    summary: 'Fluxora background job is stale'
    description: '{{ $labels.job }} has not completed successfully within its expected interval.'
```

The recurring jobs run daily. The queue heartbeat is expected every five minutes while the application is running.

## Response

### Queue

1. Check `fluxora_background_job_stale{job="queue"}` and the application logs for queue startup or shutdown failures.
2. Check database connectivity and the `pgboss` schema.
3. Restart the application if the queue process is stopped; confirm the metric records a new success.
4. Inspect `fluxora_background_job_failures_total{job="queue"}` and the DLQ before replaying failed work.

### Partition maintenance

1. Check `fluxora_background_job_failures_total{job="partition-maintenance"}` and the partition-maintenance logs.
2. Run the maintenance job once manually after confirming database DDL permissions.
3. Check for rows in the `DEFAULT` partition and follow the partition management procedure in `docs/database.md`.
4. Confirm the current and next three UTC monthly partitions exist and the stale metric clears.

### Retention purge

1. Check `fluxora_background_job_failures_total{job="retention-purge"}` and the retention-purge logs.
2. Verify the retention policy and database `DELETE` permissions.
3. Run a dry run first, then run the purge after confirming legal holds are respected.
4. Confirm the successful-run timestamp advances and review the audit events for the purge.

### Dead-letter purge

1. Check `fluxora_background_job_failures_total{job="dead-letter-purge"}` and the DLQ purge logs.
2. Verify the configured retention values and database permissions for both dead-letter tables.
3. Do not delete pending entries manually; replay or resolve them through the DLQ admin workflow first.
4. Run the bounded purge and confirm the successful-run timestamp advances and the DLQ depth is falling.
