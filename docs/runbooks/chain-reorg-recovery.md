# Chain Reorganisation Recovery — Indexer Runbook

> **Scope** Automatic detection of and recovery from a Stellar chain
> reorganisation that rewrites one or more already-indexed ledgers.
>
> **Audience** On-call engineers and operators of the Fluxora indexer.
>
> **Related files**
> - `src/indexer/service.ts` — detection during ingest, convergence guard, health snapshot
> - `src/indexer/store.ts` — `rollbackBeforeLedger`, `ReorgRecord`, `StaleCursorError`
> - `src/webhooks/dispatcher.ts` — reorg suppression for webhook deliveries
> - `docs/indexer.md` — replay integrity checks (run after every replay)
> - `tests/incidents/chainReorg.recoveryDrill.test.ts` — the drill that exercises this procedure
>
> **Issue** Fluxora-Org/Fluxora-Backend#1566

---

## 1. How a reorganisation is detected

The indexer never polls for forks; detection happens **inline, during
ingest**. Every batch accepted by `POST /internal/indexer/contract-events`
carries, for each event, the `ledger` sequence number and the `ledgerHash`
content hash of the ledger it came from.

For every distinct ledger in the batch, `IndexerIngestionService.ingest()`
compares the incoming hash against the hash already stored for that ledger:

```
existingHash := store.getLedgerHash(ledger)
if existingHash != null and existingHash != incomingHash  →  reorg at `ledger`
```

Two ledgers with the same sequence number but different content hashes mean
the canonical chain has been rewritten at or below that height — Stellar
proved the previously indexed branch is no longer canonical.

On detection the service, in order:

1. Logs `Indexer detected chain reorg` (with `ledger`, `existingHash`,
   `incomingHash`, `requestId`) at `warn` level.
2. Sets the reorg flags on the ingestion state:
   `reorgDetected = true`, `reorgHeight = <fork ledger>`.
3. Registers the fork ledger in the rolled-back set so downstream webhook
   delivery can suppress affected ledgers (see §4).
4. Calls `store.rollbackBeforeLedger(ledger)` — the store-level
   invalidation described in §3.
5. Records the failure for the health snapshot:
   `lastFailureReason = "Reorg detected at ledger <ledger>"`.

The batch that triggered the detection is **not** rejected. After the
rollback completes, the incoming (canonical-branch) events are persisted
normally, so the store converges onto the new branch in the same ingest.

## 2. What you will observe (operator signals)

| Signal | Where | Value during a reorg |
|---|---|---|
| Reorg flags | `GET /health` → `dependencies.indexer` | `reorgDetected: true`, `lastFailureReason: "Reorg detected at ledger N"` |
| Warning log | application logs | `Indexer detected chain reorg` with `ledger`, `existingHash`, `incomingHash` |
| Suppressed webhooks | `fluxora_webhook_deliveries_suppressed_total{outcome="suppressed"}` | increments while rolled-back ledgers are re-delivered |

`/health` remains servable; the reorg flags are informational and the
ingestion path keeps accepting canonical data. (`/health/ready` only exposes
flat dependency status strings, so the ingestion snapshot on `/health` is the
surface to watch.) There is no separate reorg counter on the indexer itself —
the warning log plus the health snapshot are the authoritative signals, and
the webhook suppression counter quantifies downstream impact.

## 3. Data that must be invalidated (and how)

When a fork is detected at ledger `N`, **every event at or above `N` is
invalid** — the indexer cannot know how far the old branch extended, so the
rollback is deliberately conservative:

```
DELETE all contract events with ledger >= N
```

`ContractEventStore.rollbackBeforeLedger(N)` implements this for both store
kinds:

- **Postgres** (`PostgresContractEventStore`): a single statement deletes
  from `contract_events` for `ledger >= N` *and* removes the matching rows
  from `contract_event_dedup` (the event-ID claim table). Both tables are
  cleaned in one transaction-like statement so no orphaned dedup claims block
  re-insertion of the same event IDs from the canonical branch.
- **In-memory** (`InMemoryContractEventStore`): deletes the in-memory events
  and appends a `ReorgRecord` to the reorg log (`forkLedger`, `evictedHash`,
  `removedEventIds`, `rolledBackAt`) for inspection.

### What is NOT invalidated

- Events at ledgers **below** `N` — they stay untouched.
- Replay checkpoints (`replay_progress`) — the rollback does not touch them.
- Webhook outbox/DLQ rows — already-delivered payloads are historical fact;
  affected streams are corrected by re-replaying (§5), not by rewriting
  deliveries.

### What is affected downstream

- **Webhook deliveries** for rolled-back ledgers are suppressed while the
  reorg window is open (§4). Consumers may therefore lose events that were
  delivered from the discarded branch; re-replay re-admits them (§5).
- **Replay consumers paginating with `afterEventId`** may hit a cursor that
  no longer exists. The replay endpoint returns an **empty page with HTTP
  200** for a stale cursor (it does not 500), and consumers must resync
  using `fromLedger` (§5).

## 4. Webhook suppression window

Rolled-back ledgers are remembered by the ingestion service. While a ledger
is in the rolled-back set, `dispatchWebhook({ ..., ledger })` skips delivery
and increments
`fluxora_webhook_deliveries_suppressed_total{outcome="suppressed"}` instead
of fanning out data that is about to be rewritten. Callers that omit the
`ledger` field do not get suppression and keep delivering as before.

## 5. Recovery procedure (step by step)

In most cases **steps 1–4 are automatic**: the ingest path detects, rolls
back, persists the canonical batch, and later clears the reorg state. An
operator performs steps 5–8 to verify and drive convergence. Steps 9–10 are
only needed if you believe data below the observed fork height is wrong.

1. **Acknowledge.** Note the fork ledger `N` from `GET /health`
   (`dependencies.indexer.lastFailureReason`, e.g. `Reorg detected at ledger
   512345`) or from the warning log. All observation below uses this `N`.
2. **Confirm the service is accepting canonical data.** `POST
   /internal/indexer/contract-events` must return 200 (`outcome:
   "persisted"`) for batches from the new branch. The batch that triggered
   the detection was already persisted; upstream workers just keep ingesting.
3. **Check the convergence guard.** The service intentionally refuses to
   clear the reorg state until a later batch reaches
   `maxLedger > N + 5`. Until then `reorgDetected` stays `true` — this is
   expected, not a malfunction. Do not restart the service to "clear" it.
4. **Watch the state clear.** Once an ingest batch crosses
   `maxLedger > N + 5`, the service sets `reorgDetected = false`, drops
   `reorgHeight`, and removes `N` from the rolled-back set. Verify via
   `GET /health`: `dependencies.indexer.reorgDetected` is `false` and no
   new suppression is counted. (`lastFailureReason` intentionally keeps the
   historical `Reorg detected at ledger N` message after resolution — it is
   a last-failure record, not an active flag; only a dependency-state
   transition or service reset clears it.)
5. **Re-verify the rewritten range.** Query the replay API over the affected
   window:
   `GET /internal/indexer/events?fromLedger=<N>&toledger=<tip>&limit=...`
   Confirm the rows returned carry the canonical hashes (each row echoes its
   `ledgerHash`) and that there are no gaps in the ledger sequence.
6. **Resync downstream replay consumers.** Consumers that paginated with
   `afterEventId` and received an empty page (stale cursor) must restart
   pagination from `fromLedger=<N>` (or their last known-good ledger). The
   reorg log (`ReorgRecord.removedEventIds` on the in-memory store) lists
   exactly which event IDs were evicted, if a consumer needs the precise
   set.
7. **Verify integrity.** The replay integrity check (ledger-gap and
   duplicate detection, see `docs/indexer.md`) runs automatically after a
   replay; if you triggered one, watch for `REPLAY_INTEGRITY_ISSUE` audit
   entries. For a pure reorg rollback the manual equivalent is the gap check
   in step 5.
8. **Confirm webhook flow resumed.**
   `fluxora_webhook_deliveries_suppressed_total{outcome="suppressed"}`
   stops increasing after the rolled-back set clears (step 4). Events from
   the discarded branch that consumers never received are re-admitted by
   re-replay.
9. **Optional — force a clean re-ingest below the fork height.** Only if you
   have reason to distrust data *below* `N` (e.g. the fork depth exceeded
   what the detection window saw): trigger a DB backfill over the suspect
   range via `POST /internal/indexer/events/replay` with
   `contract_id`, `from_block`, `to_block`. This is idempotent: existing
   rows are absorbed as duplicates (`duplicateCount` in the replay
   progress), canonical rows are inserted.
10. **Post-incident.** Record `N`, the `existingHash`/`incomingHash` pair,
    and the suppression counts. If no warning was logged but hashes were
    observed to change, escalate — that would indicate detection bypass.

### Expected final state

- `contract_events` contains only canonical-branch rows: every ledger in the
  rewritten range maps to exactly one `ledger_hash`, no rows from the
  discarded branch remain.
- `contract_event_dedup` contains no claims for evicted event IDs.
- `dependencies.indexer.reorgDetected === false` on `GET /health`.
- Replay over `[N, tip]` returns canonical events with contiguous ledgers.
- Webhook suppression counter flat.

## 6. The drill

`tests/incidents/chainReorg.recoveryDrill.test.ts` exercises this
procedure end-to-end against the HTTP API with the in-memory store:

1. Ingest ledgers on the original branch (baseline tip `B`).
2. Deliver a batch containing a **different hash for ledger `N ≤ B`** —
   simulating the canonical branch overwriting the indexed one.
3. Assert the detection signal (warning logged, health flags set) and that
   the store invalidated `ledger >= N` while preserving `ledger < N`.
4. Re-ingest the canonical branch for `[N, B]` plus fresh ledgers past
   `N + 5`, and confirm the convergence guard clears `reorgDetected`.
5. Verify the replay API over `[N, tip]` returns exactly the canonical
   events with contiguous ledgers — the "correct final state" required by
   the acceptance criteria.
6. Assert webhook suppression while the rolled-back set holds `N` (the
   drill uses `vi.mock` for the metrics module so the assertion is exact
   and independent of the global Prometheus registry).
