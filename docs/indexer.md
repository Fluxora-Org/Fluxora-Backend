# Indexer Service

## Overview

The Fluxora indexer ingests contract events from the Stellar blockchain and
replays historical events into the `contract_events` table on demand.

## Replay Integrity Check

After every successful replay (triggered via `POST /events/replay` or auto-resume
on startup), the system runs an **asynchronous post-replay integrity check** that
validates the ledger-sequence contiguity of the freshly replayed data.

### What is checked

1. **Ledger gaps** — For the replayed contract and ledger range, the check
   materialises the expected ledger sequence (via `generate_series`) and compares
   it to the distinct ledgers actually present in `contract_events`. Any missing
   ledger is reported as a gap.

2. **Duplicate event entries** — The check groups `contract_events` rows by
   `(event_id, ledger)` and reports any group with `COUNT(*) > 1` as a duplicate.
   Although the INSERT path uses `ON CONFLICT DO NOTHING`, duplicate detection
   catches corner cases like concurrent races or boundary bugs.

### When it runs

The check is **fire-and-forget** — it runs asynchronously after the replay
completion block (cursor marked complete, metrics recorded). It never blocks the
replay response path.

- After `IndexerService.replayEvents()` completes successfully
- After `IndexerService.resumeIncompleteReplay()` completes

### Failure mode

The integrity check **never throws**. On detection of issues:

1. A `REPLAY_INTEGRITY_ISSUE` entry is written to the `audit_logs` table
2. Prometheus counters are incremented:
   - `indexer_replay_integrity_gaps_total` (label: `contract_id`)
   - `indexer_replay_integrity_duplicates_total` (label: `contract_id`)
3. A structured warning is logged (event: `replay_integrity_issues_detected`)

If the underlying DB query fails, the error is logged and silently swallowed.

### Efficiency

Both checks are scoped to a single `(contract_id, ledger-range)` pair and use
indexed lookups — never a full-table scan. The gap check uses `generate_series`
to materialise the expected ledger list without pulling all rows.

The maximum checked range is **100 000 ledgers** (`MAX_INTEGRITY_RANGE`). If the
replay span exceeds this, the range is clamped from the tail and a warning is
logged. This prevents OOM in pathological cases.

### Source

- **Module**: `src/indexer/replayIntegrity.ts`
- **Metrics**: `src/metrics/indexerMetrics.ts`
- **Integration**: `src/indexer/service.ts`

### Testing

Tests are in `tests/indexer/replayIntegrity.test.ts` and cover:

- Clean pass (gap-free)
- Single and multiple gap detection
- Per-contract scoping (gaps in one contract don't affect another)
- Multiple events per ledger (no false positives)
- Duplicate event detection
- Empty range handling
- Range clamping
- DB error handling (caught gracefully)
- Audit event recording
- Prometheus counter increment/decrement
- Contract ID label truncation
- Integration with IndexerService

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_REPLAY_BUDGET_MS` | `0` (no budget) | Max wall-clock duration for a single replay run |
| `INDEXER_REPLAY_BATCH_SIZE` | `100` | Rows per batch |
| `INDEXER_MAX_REPLAY_RANGE_BLOCKS` | `0` (unlimited) | Max block range per replay request |

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `indexer_replay_batches_committed_total` | Counter | Batches committed across all replays |
| `indexer_replay_rows_committed_total` | Counter | Rows inserted across all replays |
| `indexer_replay_rows_per_second` | Gauge | Throughput of active replay |
| `indexer_replay_duration_seconds` | Histogram | Duration of completed replays |
| `indexer_replay_integrity_gaps_total` | Counter | Ledger gaps detected by integrity check |
| `indexer_replay_integrity_duplicates_total` | Counter | Duplicate events detected by integrity check |
| `indexer_mtls_validation_failures_total` | Counter | mTLS certificate validation failures |
