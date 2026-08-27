# Dead-Letter Queue (DLQ)

The Fluxora DLQ provides durable storage for delivery failures and an administrator-facing API to inspect, replay, and purge entries.

## Tables

### `dead_letter_queue`

Stores individual delivery failures. Each row represents one failed event.

| Column           | Type                     | Description                                    |
| ---------------- | ------------------------ | ---------------------------------------------- |
| `id`             | `text` (PK)              | Unique entry identifier                        |
| `topic`          | `text`                   | Consumer/event topic                           |
| `payload`        | `jsonb`                  | Original event payload                         |
| `error`          | `text`                   | Error message from the failed delivery         |
| `attempts`       | `integer`                | Number of delivery attempts                    |
| `correlation_id` | `text`                   | Correlation ID from the originating request    |
| `first_failed_at`| `timestamp with time zone`| Timestamp of the first failure                |
| `last_failed_at` | `timestamp with time zone`| Timestamp of the most recent failure          |
| `status`         | `text`                   | `dead` (pending) or `replayed` (resolved)      |

### `dlq_consumer_suspension`

Tracks per-topic suspension state to prevent infinite replay loops.

| Column                | Type                     | Description                            |
| --------------------- | ------------------------ | -------------------------------------- |
| `topic`               | `text` (PK)              | Consumer/event topic                   |
| `consecutive_failures`| `integer`                | Count of consecutive replay failures   |
| `suspended`           | `boolean`                | Whether the consumer is suspended      |
| `suspended_at`        | `timestamptz`            | When suspension was triggered          |
| `resumed_at`          | `timestamptz`            | When suspension was cleared            |
| `updated_at`          | `timestamptz`            | Last update timestamp                  |

## API Endpoints

All endpoints require administrator authentication.

- `GET /admin/dlq` — List DLQ entries with pagination and optional topic filter
- `GET /admin/dlq/:id` — Get a single entry with suspension status
- `POST /admin/dlq/:id/replay` — Replay a single entry
- `DELETE /admin/dlq/:id` — Delete a single entry
- `DELETE /admin/dlq` — Bulk delete (optional `?topic=` filter)
- `POST /admin/dlq/consumers/:topic/resume` — Resume a suspended consumer

## Retention Purge Policy

### Overview

The DLQ retention purge job automatically removes entries in **terminal states** that are older than a configurable retention window. This prevents unbounded growth of the `dead_letter_queue` table.

### Terminal States

Entries eligible for purge:
1. **Resolved** — `status = 'replayed'` (explicitly resolved by an operator replay)
2. **Exhausted** — `status = 'dead'` with `last_failed_at` older than the retention window (abandoned / permanently failed)

Entries that are **never** purged:
- `status = 'dead'` with a recent `last_failed_at` (still pending replay or in-flight)

### Configuration

| Environment Variable   | Default | Description                                              |
| ---------------------- | ------- | -------------------------------------------------------- |
| `DLQ_RETENTION_DAYS`   | `30`    | Retention window in days. Set to `0` to disable purging. |
| `DLQ_PURGE_BATCH_SIZE` | `500`   | Max rows deleted per job invocation.                     |

### Job Scheduling

The purge job runs as part of the daily `partition-maintenance` pg-boss job (scheduled via cron `0 0 * * *`). Each invocation processes at most `DLQ_PURGE_BATCH_SIZE` rows to keep lock duration short on `dead_letter_queue`.

### Audit Trail

Every purge invocation that deletes ≥1 row emits a `DLQ_RETENTION_PURGED` audit event with:
- `rowsPurged` — count of deleted entries
- `cutoffDate` — ISO-8601 cutoff timestamp
- `retentionDays` — configured retention window
- `batchSize` — batch size used

### Security

- **No SQL injection**: The cutoff date is passed as a parameterized value (`$2`) — never interpolated into the SQL string.
- **No TOCTOU race**: The WHERE clause evaluates both `status` and `last_failed_at` atomically within the DELETE, so a concurrent replay cannot cause a pending entry to be purged.
- **Minimal locking**: Each invocation uses `LIMIT` to bound the number of rows affected, keeping the lock window short.
- **DB principal**: The job runs with the application's standard database credentials, requiring only `DELETE` on `dead_letter_queue`.

### Monitoring

The job logs at `info` level on every invocation:
- Starting: cutoff date, retention window, batch size
- Complete: rows purged, cutoff date
- Skipped: when `retentionDays=0` (purging disabled)
- Error: when the repository call fails (re-throws to trigger pg-boss retry)
