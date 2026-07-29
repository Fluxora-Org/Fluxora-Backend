# feat: add post-replay ledger-sequence integrity check

**Closes #1216**

## Summary

After a manual reindex or replay triggered via `/api/admin/reindex` or `POST /events/replay`, there was no automated check that the resulting `contract_events` rows form a contiguous, gap-free ledger sequence per contract. Silently skipped ledgers (e.g. from a dropped RPC page mid-replay) could go unnoticed.

This PR adds a **post-replay integrity check** that runs asynchronously after every successful replay, verifying ledger-sequence contiguity and flagging gaps or duplicate event entries via structured audit logging and Prometheus counters.

---

## Changes

### New files

| File | Purpose |
|---|---|
| `src/indexer/replayIntegrity.ts` | Core module — `checkReplayIntegrity()` function with gap detection, duplicate detection, audit logging, and Prometheus counter integration |
| `tests/indexer/replayIntegrity.test.ts` | 22 comprehensive unit tests covering all edge cases |
| `docs/indexer.md` | User-facing documentation for the integrity check feature |
| `PR_DESCRIPTION.md` | This PR description |

### Modified files

| File | Change |
|---|---|
| `src/indexer/service.ts` | Imported `checkReplayIntegrity`; added fire-and-forget integrity check call after `replayEvents()` completes; added `runPostReplayIntegrityCheck()` private helper using a ±1000 ledger window |
| `src/metrics/indexerMetrics.ts` | Added `indexerReplayIntegrityGapsTotal` and `indexerReplayIntegrityDuplicatesTotal` Prometheus counters (both with `contract_id` label); added deregistration in `deRegisterIndexerMetrics()` |
| `src/lib/auditLog.ts` | Added `REPLAY_INTEGRITY_ISSUE` to the `AuditAction` union type |

---

## Design

### How the check works

1. **Trigger**: After `IndexerService.replayEvents()` marks the cursor as complete and records metrics, it fires `runPostReplayIntegrityCheck()` asynchronously via `.catch()`. The replay response path is never blocked.

2. **Scope**: The check runs against a ±1000 ledger window around the replayed ledger (not using `from_block`/`to_block`, which are block-height filters on the source `historical_events` table, not ledger numbers on `contract_events`). A separate hard cap of 100 000 ledgers (`MAX_INTEGRITY_RANGE`) prevents OOM from `generate_series` on pathological ranges.

3. **Gap detection**: Uses `generate_series` to materialise the expected ledger list for the contract within the range, then LEFT JOINs with the distinct ledgers actually present in `contract_events`. Missing ledgers are reported as gaps.

4. **Duplicate detection**: Groups `contract_events` rows by `(event_id, ledger)` and reports any group with `COUNT(*) > 1`. Although the INSERT uses `ON CONFLICT DO NOTHING`, this catches corner cases like concurrent races or batch-boundary bugs.

5. **On detection**: A structured `REPLAY_INTEGRITY_ISSUE` entry is written to the `audit_logs` table via `recordAuditEventToDb()`, Prometheus counters are incremented, and a structured warning is logged.

6. **Failure mode**: The check **never throws**. DB errors are caught, logged at warn level, and returned in the result's `error` field. Audit write failures are caught and logged internally.

### SQL queries (all parameterized — no injection vectors)

| Query | Purpose |
|---|---|
| `RANGE_QUERY` | `SELECT MIN(ledger), MAX(ledger) … WHERE contract_id = $1 AND ledger BETWEEN $2 AND $3` |
| `GAP_QUERY` | CTE with `generate_series($1, $2)` LEFT JOINed against `SELECT DISTINCT ledger …` to find missing ledgers |
| `DUPLICATE_QUERY` | `SELECT event_id, ledger, COUNT(*) … GROUP BY event_id, ledger HAVING COUNT(*) > 1` |

### Security

- All SQL queries use positional parameters (`$1`, `$2`, …) — no user-supplied values are ever interpolated into query strings.
- The `contract_id` label on Prometheus counters is truncated to 64 characters to prevent metric cardinality blowup.
- The audit entry meta field is limited to 100 gap entries and 50 duplicate entries to prevent oversized log payloads.
- The `MAX_INTEGRITY_RANGE` cap (100 000 ledgers) prevents `generate_series` from exhausting memory or causing slow queries.

---

## Test coverage

**22 tests** across 11 describe blocks in `tests/indexer/replayIntegrity.test.ts`:

| Category | Tests | What's covered |
|---|---|---|
| Clean pass | 2 | Contiguous gap-free range, single event |
| Gap detection | 4 | Single gap, multiple gaps, per-contract scoping, multiple events per ledger (no false positives) |
| Duplicate detection | 3 | Single duplicate, multiple duplicates, unique events on same ledger (no false positives) |
| Empty range | 1 | No events for contract → `hasIssues: false` |
| Range clamping | 1 | Range > 100K → warning logged, check still runs on clamped tail |
| DB error handling | 2 | Error caught and returned in `error` field, warning logged |
| Audit event | 3 | Entry written on gap detection, not written on clean pass, safe on audit write failure |
| Prometheus counters | 3 | Gap counter incremented, duplicate counter incremented, neither incremented on clean pass |
| Contract ID label | 1 | Long contract_id truncated to 64 chars in metric labels |
| IndexerService integration | 1 | `runPostReplayIntegrityCheck` called after `replayEvents` completes |

All tests pass: `22 passed, 0 failed`

---

## Monitoring & Observability

### New Prometheus metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `indexer_replay_integrity_gaps_total` | Counter | `contract_id` | Total ledger gaps detected |
| `indexer_replay_integrity_duplicates_total` | Counter | `contract_id` | Total duplicate event entries detected |

### New audit action

| Action | Resource type | When emitted |
|---|---|---|
| `REPLAY_INTEGRITY_ISSUE` | `contract_events` | When gaps or duplicates are detected after a replay |

### Structured log events

| Event | Level | Description |
|---|---|---|
| `replay_integrity_issues_detected` | `warn` | Gaps/duplicates found — includes count, range, and sample entries |
| `replay_integrity_range_clamped` | `warn` | Range exceeded 100K limit and was clamped |
| `replay_integrity_query_failed` | `warn` | DB query error (transient, caught) |
| `replay_integrity_audit_failed` | `warn` | Audit write failed (caught, non-blocking) |
| `post_replay_integrity_check_failed` | `warn` | Integrity check itself threw unexpectedly (safety net) |

---

## Backward compatibility

- **Fully backward-compatible**. Existing replays continue to work identically.
- The integrity check only runs **after a successful replay completes** (not on existing data).
- No new database migrations required — the check queries the existing `contract_events` table.
- No new configuration variables introduced.

---

## Checklist

- [x] New module: `src/indexer/replayIntegrity.ts`
- [x] Modified: `src/indexer/service.ts` — integration
- [x] Modified: `src/metrics/indexerMetrics.ts` — Prometheus counters
- [x] Modified: `src/lib/auditLog.ts` — audit action type
- [x] New tests: `tests/indexer/replayIntegrity.test.ts` — 22 tests, all passing
- [x] New docs: `docs/indexer.md` — user-facing documentation
- [x] TypeScript: `tsc --noEmit` — no errors in modified files
- [x] SQL injection safety: all queries parameterized
- [x] Metric cardinality: contract_id truncated to 64 chars
- [x] Range safety: capped at 100 000 ledgers
- [x] Fire-and-forget: never blocks request/response cycle
