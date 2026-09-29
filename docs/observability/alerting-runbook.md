# Alerting Signals — Operational Runbook

This runbook maps every Fluxora Backend alerting signal to an operator action.
It covers the fifteen metric collectors under `src/metrics/` plus the core
Prometheus registry in `src/metrics.ts`. Use it during incidents: identify the
firing alert, confirm the metric and threshold, run the first diagnostic step,
then escalate if the signal does not clear.

Related deep-dives (do not replace this runbook):

- [Postgres vacuum](./postgres-vacuum-runbook.md)
- [Database pool metrics](./database-metrics.md)
- [Redis saturation](./redis-saturation.md)
- [Observability overview](../observability.md)

---

## How to use this runbook

1. Open the firing alert and note `alertname`, labels, and current value.
2. Find the matching section below (table of contents by collector).
3. Execute **First diagnostic** before changing production config.
4. If the signal is still firing after remediation, follow **Escalation**.

### Escalation (global)

| Severity | owner | When |
|---|---|---|
| `warning` | On-call backend | Sustained > 15 minutes after first diagnostic, or recurring within 1 hour |
| `critical` | On-call backend + page secondary | Immediate if user-facing error rate rises, data lag grows, or write path is blocked |
| Unclear ownership | Engineering lead | Alert has no matching section, or remediation requires schema/migration change |

Pager / chat: use the team's on-call rotation. Capture `correlation_id` / request IDs from structured logs when opening an incident ticket.

---

## Signal catalog

### 1. HTTP & rate-limit registry (`src/metrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| HighHttp5xxRate | `rate(http_requests_total{status_code=~"5.."}[5m])` | > 0.05 req/s for 5m | Unhandled exceptions, DB/Redis outage, bad deploy |
| HighHttpLatencyP99 | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` | > 2s for 10m | Slow queries, RPC degradation, event-loop blocking |
| RateLimitSpike | `rate(rate_limit_rejected_total[5m])` | > 10/s for 5m | Abuse, misconfigured client, too-tight limits |
| RateLimitRedisErrors | `increase(rate_limit_redis_errors_total[5m])` | > 0 for 2m | Redis connectivity / saturation |
| DedupRedisErrors | `increase(dedup_redis_errors_total[5m])` | > 0 for 2m | Redis down; hybrid cache falling back |
| BanStoreGrowth | `fluxora_ban_store_active_bans` | > 1000 for 10m | Attack traffic or ban TTL misconfig |
| ConfigReloadFailures | `increase(fluxora_config_reload_total{result="failure"}[15m])` | > 0 | Invalid hot-config / SIGHUP payload |

**First diagnostic:** `curl -H "Authorization: Bearer $ADMIN_API_KEY" https://<host>/metrics` and confirm scrape freshness; check recent deploy and `GET /health` (or status routes). Inspect structured logs for the hottest `route` label.

**Escalation:** critical if 5xx coincides with rising indexer lag or webhook DLQ depth.

---

### 2. Business / product metrics (`src/metrics/businessMetrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| WebhookDlqDepth | `fluxora_webhook_dlq_items` | > 100 | Consumer endpoint failing permanently |
| WebhookOutboxBacklog | `fluxora_webhook_outbox_pending_items` | > 1000 | Delivery worker stalled, slow consumers, Redis rate-limit / circuit open |
| WebhookDeliveryFailures | `rate(fluxora_webhook_deliveries_total{status!="success"}[5m])` | sustained rise | Downstream outage, auth errors |
| IndexerLagHigh | `fluxora_indexer_lag_seconds` | > 300 (5m) | RPC slow, batch errors, DB write pressure |
| SseBackpressureDrops | `increase(fluxora_sse_backpressure_drops_total[5m])` | > 0 | Slow SSE clients, buffer too small |
| JobDlqGrowth | `increase(fluxora_job_dlq_entries_total[15m])` | > 0 | Background job poison messages |
| PartitionMaintenanceBehind | `increase(fluxora_partition_maintenance_behind_schedule_total[1h])` | > 0 | Cron not running, lock contention |
| WsAuthFailures | `rate(fluxora_ws_auth_failure_total[5m])` | > 1/s | Bad tokens, clock skew, attack |

**First diagnostic:** Compare outbox pending vs DLQ; check webhook circuit-breaker logs and Redis rate-limit metrics. For lag, compare `fluxora_indexer_lag_seconds` with `indexer_ledger_lag` / batch error counters.

**Escalation:** page if outbox backlog and DLQ both climb while API 5xx is elevated.

---

### 3. Database query & pool metrics (`src/metrics/dbMetrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| SlowQuerySpike | `rate(fluxora_db_slow_queries_total[5m])` | > 1/s for 5m | Missing index, lock waits, vacuum debt |
| DbPoolWaiting | `fluxora_db_pool_waiting_requests` | > 0 for 30s | Pool too small, long transactions |
| DbPoolExhausted | `increase(fluxora_db_pool_exhausted_total[5m])` | > 0 | Connection leak, overload |
| ReplicationLag | `fluxora_db_replication_lag_seconds` | > 30 for 5m | Replica pressure, network |

**First diagnostic:** Identify top `operation` on `fluxora_db_query_duration_seconds`; check `pg_stat_activity` for waiting/blocking PIDs; confirm pool gauges (`active`/`idle`/`waiting`).

**Escalation:** critical when pool exhausted coincides with HTTP 5xx.

---

### 4. Legacy / labeled pool gauges (`src/metrics/pool.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| DbPoolQueueBuildup | `db_pool_waiting` | > 0 for 30s | Same as dbMetrics waiting |
| DbPoolNearExhaustion | `db_pool_active / (db_pool_active + db_pool_idle)` | > 0.9 for 1m | Undersized pool, stuck queries |
| NegativeActiveAnomaly | `increase(fluxora_db_pool_negative_active_total[5m])` | > 0 | Instrumentation bug / double-release |

**First diagnostic:** Cross-check against `fluxora_db_pool_*` series; inspect recent deploys touching the pool wrapper.

**Escalation:** treat as critical with DbPoolExhausted if waiting stays non-zero > 2m under traffic.

---

### 5. Indexer ledger lag (`src/metrics/indexerLag.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| IndexerLagWarning | `indexer_ledger_lag` | ≥ 100 ledgers for 5m | Indexer not catching up; RPC slow, batch errors, DB write pressure |
| IndexerLagCritical | `indexer_ledger_lag` | ≥ 300 ledgers for 10m | Data freshness SLA violated; RPC outage, DB saturation, process stalled |
| IndexerCatchupEtaHigh | `indexer_catchup_eta_seconds` | > 1800 for 10m | Throughput too low; slow batches, RPC rate-limiting, DB contention |
| IndexerBackfillPausedTooLong | `indexer_backfill_paused` | == 1 for 15m | Backfill yielding to live indexing (info only; expected behavior) |

#### Threshold rationale

Stellar mainnet produces a ledger every ~5 seconds. Under healthy conditions:
- **p50 lag**: 0–2 ledgers (0–10 seconds)
- **p95 lag**: 3–5 ledgers (15–25 seconds)
- **p99 lag**: 8–15 ledgers (40–75 seconds)

Brief spikes to 20–30 ledgers (2–3 minutes) occur during deployments or transient RPC timeouts. Sustained lag above 60 ledgers indicates a systemic issue.

**Warning threshold (100 ledgers ≈ 8 minutes)**: The indexer is not catching up on its own. The 5-minute `for` clause filters deployment restarts and single RPC failures.

**Critical threshold (300 ledgers ≈ 25 minutes)**: Data is stale enough to violate the implicit freshness SLA. Client-visible impact: outdated balances, missed events, delayed webhooks. Requires immediate action.

See `src/config/indexer-thresholds.ts` for detailed rationale and `docs/observability/indexer-lag-alerts.yml` for the Prometheus rules.

#### First diagnostic

1. **Confirm the indexer is running:**
   ```bash
   ps aux | grep indexer
   curl http://localhost:$PORT/metrics | grep indexer_ledger_lag
   ```

2. **Check current lag and trend:**
   ```promql
   # Current lag in ledgers
   indexer_ledger_lag

   # Lag trend over the last hour
   delta(indexer_ledger_lag[1h])
   ```
   If `delta` is positive and growing, the indexer is falling further behind.

3. **Check RPC provider health:**
   ```promql
   rpc_provider_healthy          # Should be 1
   rpc_circuit_open_fallback_hits_total  # Circuit breaker tripped?
   rate(rpc_provider_health_check_failures_total[5m])  # Recent failures?
   ```
   If `rpc_provider_healthy == 0`, check the provider's status page and circuit breaker logs.

4. **Review batch processing errors:**
   ```promql
   rate(indexer_batch_errors_total[5m])  # Error rate per second
   sum by (error_source, error_type) (indexer_batch_errors_total)
   ```
   - High `error_source="stellar_rpc"` → upstream RPC issue (provider outage, rate-limiting)
   - High `error_source="local"` with `error_type="db_*"` → database pressure or pool exhaustion

5. **Check database pool and query health:**
   ```promql
   fluxora_db_pool_waiting_requests      # Should be 0
   increase(fluxora_db_pool_exhausted_total[5m])  # Pool exhaustion events
   rate(fluxora_db_slow_queries_total[5m])        # Slow query rate
   histogram_quantile(0.99, rate(fluxora_db_query_duration_seconds_bucket[5m]))
   ```

6. **Inspect structured logs for recent batch failures:**
   ```bash
   grep "indexer_batch" /var/log/fluxora/*.log | tail -n 50
   grep "error_source\|error_type" /var/log/fluxora/*.log | tail -n 20
   ```

7. **Compare throughput to baseline:**
   ```promql
   rate(indexer_batches_processed_total[5m])  # Batches/sec (should be >0)
   indexer_replay_rows_per_second             # Current throughput gauge
   ```
   If throughput is near zero while lag is high, the indexer is stalled or blocked.

#### Remediation by cause

| Cause | Remediation |
|-------|-------------|
| **RPC provider outage** | Verify provider status page; if prolonged, consider temporary fallback RPC URL (requires config change + restart) |
| **RPC rate-limiting** | Check `rpc_circuit_open_fallback_hits_total`; circuit breaker is protecting you; wait for provider recovery or increase `STELLAR_RPC_TIMEOUT` |
| **Database pool exhausted** | Increase `DB_POOL_MAX` if safe; identify long-running transactions in `pg_stat_activity`; consider query optimization |
| **Database slow queries** | Run `EXPLAIN ANALYZE` on hot queries; check for missing indexes; review `pg_stat_user_tables` for bloat |
| **Indexer process stalled** | Check event-loop lag (`fluxora_nodejs_event_loop_lag_seconds`); if >1s, suspect sync CPU work or GC thrash; restart if necessary |
| **Backfill competing for resources** | If `indexer_backfill_paused == 0` while lag is high, the backfill should have paused but didn't; check `maxLiveIndexingLag` config |

#### Recovery validation

After remediation, confirm:
1. `indexer_ledger_lag` is decreasing (not flat or growing)
2. `indexer_catchup_eta_seconds` is shrinking
3. `indexer_batch_errors_total` stops increasing
4. Alert resolves within 1–2 scrape intervals after lag drops below threshold

#### Escalation

| Severity | When | Who |
|----------|------|-----|
| **Warning** | Sustained >15 minutes after first diagnostic, or recurring within 1 hour | On-call backend |
| **Critical** | Immediately if lag is growing or user reports indicate stale data | On-call backend + page secondary |
| **Engineering lead** | Lag persists >30 minutes despite remediation; possible schema/infra issue | Engineering lead + DBA |

**Critical escalation checklist:**
- [ ] Indexer process is running and not CPU/event-loop blocked
- [ ] RPC provider is healthy (`rpc_provider_healthy == 1`)
- [ ] Database pool is not exhausted
- [ ] Batch error rate is not elevated
- [ ] Lag is still growing after 15+ minutes

If all checks pass but lag persists, suspect:
- Silent RPC provider degradation (slow but not failing)
- Postgres vacuum or long-running transaction blocking writes
- Network partition between indexer and RPC/DB
- Indexer logic bug (consult recent deploys and changelogs)

Capture a snapshot before restarting:
```bash
curl http://localhost:$PORT/metrics > /tmp/metrics-snapshot.txt
pg_stat_activity > /tmp/db-snapshot.txt
```

#### Validation (induced incident)

To verify the alert fires as documented:

1. **Induce lag in staging:**
   - Pause the indexer process: `kill -STOP $(pgrep -f indexer)`
   - Wait 6+ minutes for lag to accumulate past 100 ledgers
   - Check Prometheus: `indexer_ledger_lag` should be climbing

2. **Confirm warning alert fires:**
   - After 5 minutes of sustained lag ≥100, `IndexerLagWarning` should be pending
   - After 5 minutes pending, it should transition to firing

3. **Extend to critical:**
   - Keep the process paused for 15+ total minutes
   - Lag should cross 300 ledgers after ~25 minutes (300 ledgers × 5s/ledger ÷ 60)
   - After 10 minutes above 300, `IndexerLagCritical` should fire

4. **Validate recovery:**
   - Resume the process: `kill -CONT $(pgrep -f indexer)`
   - Watch lag decrease: `watch -n 2 'curl -s http://localhost:$PORT/metrics | grep indexer_ledger_lag'`
   - Alerts should resolve within 1–2 scrape intervals after lag drops below threshold

5. **Record results:**
   - Time to detect (lag starts → alert fires)
   - Time to resolve (remediation → alert clears)
   - Any false positives or missed detections

See `tests/observability/indexer-lag-alert-validation.test.ts` for an automated validation test.

---

### 6. Indexer replay metrics (`src/metrics/indexerMetrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| ReplayIntegrityGaps | `increase(indexer_replay_integrity_gaps_total[15m])` | > 0 | Missing ledgers / cursor jump |
| ReplayIntegrityDuplicates | `increase(indexer_replay_integrity_duplicates_total[15m])` | > 0 | Overlapping replay windows |
| ReplayRetries | `rate(indexer_replay_retries_total[5m])` | > 0.2/s | Transient RPC/DB failures |
| MtlsValidationFailures | `increase(indexer_mtls_validation_failures_total[10m])` | > 0 | Bad client certs / misconfig |
| ReplayWorkersStarved | `indexer_replay_active_workers == 0` and rows/s == 0 while lag high | for 5m | Worker crash, queue stuck |

**First diagnostic:** Check replay checkpoint sequence monotonicity; inspect `reason` labels on retries/mTLS failures; verify admin reindex job duration histogram.

**Escalation:** engineering lead if integrity gaps appear (possible data correctness issue).

---

### 7. Indexer RED metrics (`src/metrics/indexerRed.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| IndexerBatchErrors | `rate(indexer_batch_errors_total[5m])` | > 0.1/s for 5m | RPC errors, decode failures, DB write errors |
| IndexerBatchPartialFailureHigh | `sum(rate(indexer_batches_processed_total{outcome="partial"}[5m])) / sum(rate(indexer_batches_processed_total[5m]))` | > 0.01 for 10m | Batches rolled back before COMMIT (stop requested mid-batch); rows dropped, ledger range not advanced |
| IndexerBatchTooSlow | `histogram_quantile(0.99, rate(indexer_batch_duration_seconds_bucket[5m]))` | > 30s | Heavy ledgers, DB latency |
| IndexerThroughputDrop | `rate(indexer_batches_processed_total[5m])` | near 0 while lag rising | Process hung |

`indexer_batch_errors_total` counts **partial** batch failures as well as wholly
failed ones, so the error rate is never understated. The `outcome` label on
`indexer_batches_processed_total` (`success` / `partial` / `error`) is what
separates them, and `error_type="batch_aborted"` identifies the partial drop.

**First diagnostic:** Diff error logs around last successful batch timestamp; correlate with `rpc_provider_healthy` and DB slow-query rate. For `IndexerBatchPartialFailureHigh`, look for `replay_batch_aborted` / `replay_stopped_by_shutdown` log lines and re-run the replay for the affected range.

**Escalation:** page if throughput is zero for > 5m in production. Treat a sustained `IndexerBatchPartialFailureHigh` as a data-completeness issue: the affected ledger range is still un-ingested, so a resume is owed even though no batch threw.

---

### 8. Redis saturation (`src/metrics/redisPool.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| RedisQueueBuildup | `redis_command_queue_length` | > 100 for 1m | Slow Redis, command storms |
| RedisQueueCritical | `redis_command_queue_length` | > 1000 for 30s | Severe saturation |
| RedisConnectionDegraded | `redis_connection_status != 3` | for 10s | Network blip, auth failure, failover |
| RedisQueueThresholdHit | `increase(redis_queue_length_warnings_total[5m])` | > 0 | Crossed `REDIS_QUEUE_WARNING_THRESHOLD` (default 500) |

**First diagnostic:** Confirm Redis `INFO` latency/`connected_clients`; check which `instance` label is unhealthy; review rate-limit and dedup fallback counters.

**Escalation:** critical when status ≠ ready and HTTP/webhook errors rise. See also [redis-saturation.md](./redis-saturation.md).

---

### 9. Request protection (`src/metrics/requestProtectionMetrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| OversizedBodyProbe | `increase(fluxora_request_body_too_large_total[5m])` | > 50 | DoS probes, misbehaving client |
| WebhookLimiterEmpty | `fluxora_webhook_rate_limiter_bucket_fill` | near 0 under backlog | Tokens exhausted / Redis issue |

**First diagnostic:** Inspect top `path` labels; confirm body size limits in env; correlate with ban-store growth.

**Escalation:** security on-call if probe volume is sustained across many source IPs.

---

### 10. Stellar RPC fallback (`src/metrics/rpcMetrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| RpcCircuitOpenHits | `rate(rpc_circuit_open_fallback_hits_total[5m])` | > 1/s | Primary RPC unhealthy |
| RpcCircuitOpenMisses | `rate(rpc_circuit_open_fallback_misses_total[5m])` | > 0.2/s | Fallback cache cold/empty |
| RpcProviderUnhealthy | `rpc_provider_healthy == 0` | for 2m | Provider outage |
| RpcHealthCheckFailures | `increase(rpc_provider_health_check_failures_total[10m])` | > 3 | Network / auth to provider |
| RpcCacheCorrupt | `increase(fluxora_rpc_cache_corrupt_total[15m])` | > 0 | Poisoned/invalid cache entries |

**First diagnostic:** Check provider status page; verify fallback cache hit ratio; clear corrupt cache keys only after confirming envelope shape in logs.

**Escalation:** critical when provider unhealthy and indexer lag climbing.

---

### 11. Node.js runtime (`src/metrics/runtimeMetrics.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| EventLoopLagP99 | `histogram_quantile(0.99, rate(fluxora_nodejs_event_loop_lag_seconds_bucket[5m]))` | > 1s for 5m | Sync CPU work, giant JSON, GC thrash |
| HeapPressure | `fluxora_nodejs_heap_used_bytes / fluxora_nodejs_heap_total_bytes` | > 0.85 for 10m | Memory leak, large buffers |
| ExternalMemoryGrowth | `fluxora_nodejs_external_bytes` | sustained climb 30m | Buffer/addon retention |

**First diagnostic:** Capture process RSS/heap; review recent CPU profiles if available; check WS/SSE connection counts for fan-out storms.

**Escalation:** restart only after capturing metrics snapshot; page if lag > 1s and 5xx elevated.

---

### 12. Postgres vacuum collector (`src/metrics/vacuumCollector.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| HighTableBloat | `fluxora_pg_bloat_ratio` | > 0.20 for 10m | Autovacuum lag |
| CriticalTableBloat | `fluxora_pg_bloat_ratio` | > 0.40 for 5m | Autovacuum blocked |
| AutovacuumStalled | `fluxora_pg_last_autovacuum_age_seconds` | > 86400 | Long tx / misconfig |
| HighDeadTupleCount | `fluxora_pg_dead_tuples` | > 500000 for 5m | Write-heavy table debt |

**First diagnostic:** Follow [postgres-vacuum-runbook.md](./postgres-vacuum-runbook.md) — check `pg_stat_activity` for blockers, then `VACUUM ANALYZE` if safe.

**Escalation:** DBA / platform if critical bloat persists after manual vacuum.

---

### 13. WebSocket backpressure (`src/metrics/wsBackpressure.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| WsSlowClients | `fluxora_ws_slow_clients` | > 10 for 5m | Clients not reading (default slow threshold 1 MiB) |
| WsBufferedBytesHigh | `fluxora_ws_max_buffered_bytes` | approaching drop limit | Broadcast storms, slow peers |
| WsBatchSizeExceeded | `increase(fluxora_ws_batch_size_exceeded_total[5m])` | > 0 | Oversized micro-batches |

**First diagnostic:** Identify streams with highest `fluxora_ws_stream_subscriber_count`; inspect hub backpressure drop logs; consider disconnecting stuck peers.

**Escalation:** critical if slow clients correlate with event-loop lag or OOM risk.

---

### 14. WebSocket connections (`src/metrics/wsConnections.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| WsNearCapacity | `websocket_active_connections / websocket_max_connections_per_ip` (or absolute active) | > 80% capacity for 5m | Organic growth or connection leak |
| WsConnStorm | `increase(websocket_active_connections[5m])` jump | large step | Reconnect storm after outage |

**First diagnostic:** Check per-IP limits and load balancer idle timeouts; confirm clients close cleanly on error.

**Escalation:** scale horizontally or tighten limits if capacity > 90% sustained.

---

### 15. WebSocket health (`src/metrics/wsHealth.ts`)

| Alert | Metric | Threshold | Likely causes |
|---|---|---|---|
| WsHealthFailures | `rate(fluxora_ws_connection_health_total{result!="ok"}[5m])` (or non-success label) | > 0.5/s | Handshake failures, heartbeat misses |

**First diagnostic:** Compare with `fluxora_ws_auth_failure_total` and proxy/LB access logs; verify heartbeat interval configuration.

**Escalation:** critical when failure rate coincides with user-reported stream disconnects.

---

## Induced-incident walkthrough (validation)

Use this checklist to validate the runbook without guessing:

1. **Pick one signal** (example: `RedisQueueBuildup`).
2. **Induce safely in staging:** temporarily lower `REDIS_QUEUE_WARNING_THRESHOLD` or generate Redis load so `redis_command_queue_length` exceeds 100.
3. **Confirm alert fires** in Prometheus/Alertmanager with the expected labels.
4. **Follow only this document:** run the listed first diagnostic for Redis saturation, confirm status enum and fallback counters.
5. **Remediate** (stop load / restore threshold) and confirm the alert resolves.
6. **Record** time-to-detect and time-to-mitigate in the incident ticket.

Repeat for at least one DB pool signal and one indexer lag signal before calling the runbook complete for a new environment.

---

## Collector index

| # | Collector module | Primary signals |
|---|---|---|
| 1 | `src/metrics.ts` | HTTP, rate-limit, dedup, bans, config reload |
| 2 | `src/metrics/businessMetrics.ts` | Webhooks, SSE, indexer lag gauge, jobs, partitions |
| 3 | `src/metrics/dbMetrics.ts` | Query latency, slow queries, pool, replication |
| 4 | `src/metrics/pool.ts` | `db_pool_*` gauges |
| 5 | `src/metrics/indexerLag.ts` | Ledger lag, catch-up ETA |
| 6 | `src/metrics/indexerMetrics.ts` | Replay integrity / workers |
| 7 | `src/metrics/indexerRed.ts` | Batch rate/errors/duration |
| 8 | `src/metrics/redisPool.ts` | Redis queue & connection status |
| 9 | `src/metrics/requestProtectionMetrics.ts` | 413s, webhook limiter fill |
| 10 | `src/metrics/rpcMetrics.ts` | Circuit fallback, provider health |
| 11 | `src/metrics/runtimeMetrics.ts` | Heap, event-loop lag |
| 12 | `src/metrics/vacuumCollector.ts` | Dead tuples, bloat, autovacuum age |
| 13 | `src/metrics/wsBackpressure.ts` | Slow clients, buffered bytes |
| 14 | `src/metrics/wsConnections.ts` | Active WS connections |
| 15 | `src/metrics/wsHealth.ts` | Connection health totals |
