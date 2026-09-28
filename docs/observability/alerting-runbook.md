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
| IndexerLedgerLag | `indexer_ledger_lag` | > 100 ledgers for 5m | Catch-up needed, RPC stall |
| IndexerCatchupEtaHigh | `indexer_catchup_eta_seconds` | > 1800 for 10m | Throughput too low vs gap |

**First diagnostic:** Confirm indexer process is running; check RPC provider health gauges; review latest batch error logs.

**Escalation:** critical if lag grows for > 15m while `indexer_batch_errors_total` increases.

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
