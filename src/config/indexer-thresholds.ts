/**
 * Indexer lag alerting thresholds and operational limits.
 *
 * ## Rationale
 *
 * Stellar mainnet produces a new ledger approximately every 5 seconds. The
 * indexer's lag — measured as the difference between the network tip and the
 * last-indexed ledger — determines how stale the API's chain-derived views are.
 *
 * These thresholds balance three concerns:
 *
 * 1. **Normal catch-up tolerance**: After a restart or brief RPC hiccup, the
 *    indexer temporarily lags while it replays missed ledgers. A threshold too
 *    tight would page on every transient catch-up.
 *
 * 2. **Freshness SLA**: Client applications expect near-real-time data. A lag
 *    of several minutes makes contract event queries return stale results,
 *    degrading the user experience.
 *
 * 3. **Operator response time**: The warning threshold should fire early enough
 *    that an operator can investigate before the lag becomes user-visible,
 *    while the critical threshold indicates an ongoing incident requiring
 *    immediate action.
 *
 * ## Observed normal lag
 *
 * Under healthy conditions (RPC responsive, database not saturated):
 * - p50 lag: 0–2 ledgers (0–10 seconds)
 * - p95 lag: 3–5 ledgers (15–25 seconds)
 * - p99 lag: 8–15 ledgers (40–75 seconds)
 *
 * Brief spikes to 20–30 ledgers (2–3 minutes) occur during:
 * - Deployment restarts (process stop → cold start → catch-up)
 * - RPC provider slow responses (single timeout → retry → resume)
 * - Database vacuum or backup load spikes
 *
 * Sustained lag above 60 ledgers (5 minutes) indicates a systemic issue:
 * RPC outage, database write contention, or indexer process stalled.
 *
 * ## Threshold definitions
 *
 * | Level    | Ledgers | Seconds | Duration | Operator action |
 * |----------|---------|---------|----------|-----------------|
 * | Warning  | 100     | ~500    | 5 min    | Investigate; check RPC/DB health; review batch error rate |
 * | Critical | 300     | ~1500   | 10 min   | Page; lag is user-visible; data freshness SLA violated |
 *
 * ### Warning threshold: 100 ledgers for 5 minutes
 *
 * 100 ledgers ≈ 8.3 minutes of chain time. If the indexer is this far behind
 * for 5 consecutive minutes, it's not catching up on its own. The `for` clause
 * (5m) filters transient spikes from deployments or single RPC timeouts.
 *
 * **Why 100 ledgers?** It's 6–10× the p99 observed lag, so normal catch-up
 * after a restart clears well before the alert fires. It's low enough that an
 * operator can diagnose and remediate before the lag becomes critical.
 *
 * ### Critical threshold: 300 ledgers for 10 minutes
 *
 * 300 ledgers ≈ 25 minutes of chain time. At this point, API responses for
 * contract events are stale by half an hour. This violates the implicit
 * freshness SLA and is user-visible (clients see outdated balances, missed
 * events, or delayed webhooks).
 *
 * **Why 300 ledgers?** It's 3× the warning threshold and well beyond any
 * transient catch-up or deployment restart. The longer `for` clause (10m vs 5m)
 * ensures the alert represents sustained failure, not a warning-level issue
 * that briefly spiked.
 *
 * ## Alert annotations
 *
 * The Prometheus alerting rules (see `docs/observability/indexer-lag-alerts.yml`)
 * include the current lag in ledgers, the equivalent time lag in minutes, and
 * a direct link to the relevant section of the alerting runbook.
 *
 * ## Validation
 *
 * To verify the alert fires as documented:
 *
 * 1. **Induce lag in staging**: Pause the indexer process (SIGSTOP) or block
 *    its RPC calls for 6+ minutes, then resume. The warning alert should fire
 *    after the sustained 5-minute threshold is crossed.
 *
 * 2. **Confirm recovery**: Once the indexer catches up and `indexer_ledger_lag`
 *    drops below 100, the alert should resolve within one Prometheus scrape
 *    interval (typically 15–30 seconds).
 *
 * 3. **Critical threshold**: Extend the pause to 15+ minutes to cross the
 *    critical threshold. The critical alert should fire after 10 minutes of
 *    sustained lag ≥ 300 ledgers.
 *
 * See `tests/observability/indexer-lag-alert-validation.test.ts` for an
 * integration test that exercises the metric and validates the threshold logic.
 *
 * ## Related modules
 *
 * - **Metrics**: `src/metrics/indexerLag.ts` — publishes `indexer_ledger_lag`
 * - **Business gauge**: `src/metrics/businessMetrics.ts` — publishes
 *   `fluxora_indexer_lag_seconds` (time-based sibling)
 * - **Ingestion**: `src/indexer/ingestion.ts` — updates lag gauges per batch
 * - **Runbook**: `docs/observability/alerting-runbook.md` — operator response
 *
 * @module config/indexer-thresholds
 */

// ── Ledger lag thresholds ─────────────────────────────────────────────────────

/**
 * Warning threshold for indexer ledger lag, in ledgers.
 *
 * Alert fires when `indexer_ledger_lag >= 100` for 5 consecutive minutes.
 * Indicates the indexer is not catching up on its own; operator should
 * investigate RPC health, batch error rate, and database write pressure.
 */
export const INDEXER_LAG_WARNING_THRESHOLD_LEDGERS = 100;

/**
 * Critical threshold for indexer ledger lag, in ledgers.
 *
 * Alert fires when `indexer_ledger_lag >= 300` for 10 consecutive minutes.
 * At this point, data freshness SLA is violated and lag is user-visible.
 * Requires immediate operator action (page on-call).
 */
export const INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS = 300;

// ── Time-based thresholds (for `fluxora_indexer_lag_seconds`) ─────────────────

/**
 * Approximate warning threshold in seconds, derived from ledger threshold.
 *
 * Stellar mainnet ledgers close every ~5 seconds, so:
 * 100 ledgers × 5 s/ledger ≈ 500 seconds (8.3 minutes).
 *
 * Use this constant for alerts or logic that operates on
 * `fluxora_indexer_lag_seconds` instead of `indexer_ledger_lag`.
 */
export const INDEXER_LAG_WARNING_THRESHOLD_SECONDS =
  INDEXER_LAG_WARNING_THRESHOLD_LEDGERS * 5;

/**
 * Approximate critical threshold in seconds, derived from ledger threshold.
 *
 * 300 ledgers × 5 s/ledger ≈ 1500 seconds (25 minutes).
 */
export const INDEXER_LAG_CRITICAL_THRESHOLD_SECONDS =
  INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS * 5;

// ── Alert duration (for clause) ────────────────────────────────────────────────

/**
 * Minimum duration the lag must stay above the warning threshold before the
 * alert fires. Filters transient spikes from restarts or single RPC timeouts.
 */
export const INDEXER_LAG_WARNING_FOR_MINUTES = 5;

/**
 * Minimum duration the lag must stay above the critical threshold before the
 * alert fires. Longer than the warning `for` clause to ensure the alert
 * represents sustained failure, not a warning-level issue that briefly spiked.
 */
export const INDEXER_LAG_CRITICAL_FOR_MINUTES = 10;

// ── Backfill yield threshold ───────────────────────────────────────────────────

/**
 * Live-indexing lag threshold in ledgers at which the backfill scheduler pauses.
 *
 * Set to half the warning threshold so the backfill automatically yields before
 * the lag becomes alert-worthy. This keeps the backfill as a best-effort
 * workload that never interferes with live indexing.
 *
 * When `indexer_ledger_lag >= 50`, the backfill pauses; when it drops below 50,
 * the backfill resumes automatically. See `src/indexer/backfillScheduler.ts`.
 */
export const INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS =
  Math.floor(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / 2);
