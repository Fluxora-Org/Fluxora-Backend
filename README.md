# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Today this repository exposes a minimal HTTP surface for stream CRUD and health checks. For Issue 54, the service now defines a concrete indexer-stall health classification plus an inline incident runbook so operators can reason about stale chain-derived state without relying on tribal knowledge.

## Current status

- Implemented today:
  - API info endpoint
  - health endpoint
  - in-memory stream CRUD placeholder
  - indexer freshness classification for `healthy`, `starting`, `stalled`, and `not_configured`
  - health-route reporting for indexer freshness
- Explicitly not implemented yet:
  - a real indexer worker
  - durable checkpoint persistence
  - database-backed chain state
  - automated restart orchestration
  - rate limiting or duplicate-delivery protection

If the health route reports `indexer.status = "stalled"`, treat that as an operational signal that chain-derived views would be stale if the real indexer were enabled in this service.

## Tech stack

- Node.js 18+
- TypeScript
- Express

## Local setup

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install and run

```bash
npm install
npm run dev
```

API runs at [http://localhost:3000](http://localhost:3000).

### Scripts

- `npm run dev` - run with tsx watch
- `npm run build` - compile to `dist/`
- `npm test` - run indexer freshness tests
- `npm start` - run compiled `dist/index.js`

## API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info |
| GET | `/health` | Health check with indexer freshness |
| GET | `/api/streams` | List streams |
| GET | `/api/streams/:id` | Get one stream |
| POST | `/api/streams` | Create stream with `sender`, `recipient`, `depositAmount`, `ratePerSecond`, `startTime` |

All responses are JSON. Stream data is in-memory until a durable store is added.

## Incident runbook: indexer stalled

### Service-level outcome

The single responsibility area for this issue is operator handling of a stalled indexer. The service-level outcomes are:

- health reporting must tell operators whether the indexer is `healthy`, `starting`, `stalled`, or `not_configured`
- a stalled indexer must be treated as a stale-chain-state incident, not a silent success
- public clients must not be told that chain-derived views are current when the indexer is stalled
- operators must have a written path to classify, diagnose, and respond to the stall

### Health contract

`GET /health` now includes an `indexer` object:

```json
{
  "status": "degraded",
  "service": "fluxora-backend",
  "timestamp": "2026-03-25T21:00:00.000Z",
  "indexer": {
    "status": "stalled",
    "stalled": true,
    "thresholdMs": 300000,
    "lastSuccessfulSyncAt": "2026-03-25T20:50:00.000Z",
    "lagMs": 600000,
    "summary": "Indexer checkpoint is older than the allowed freshness threshold",
    "clientImpact": "stale_chain_state",
    "operatorAction": "page"
  }
}
```

Environment variables used by the health route:

- `INDEXER_ENABLED` - set to `true` when an indexer is expected to be running
- `INDEXER_LAST_SUCCESS_AT` - ISO timestamp of the last successful sync checkpoint
- `INDEXER_STALL_THRESHOLD_MS` - optional freshness threshold, defaults to `300000`

### Meaning of each indexer status

| Status | Meaning | Overall `/health` status |
|--------|---------|--------------------------|
| `not_configured` | No indexer is expected in this environment | `ok` |
| `starting` | Indexer is enabled but no readable successful checkpoint exists yet | `degraded` |
| `healthy` | Last checkpoint is within the freshness threshold | `ok` |
| `stalled` | Last checkpoint is older than the freshness threshold | `degraded` |

### Trust boundaries

| Actor | Trusted for | Not trusted for |
|-------|-------------|-----------------|
| Public internet clients | Reading public health information | Deciding whether stale chain state is acceptable for operators or auditors |
| Authenticated partners | Consuming health output and handling stale data conservatively | Overriding freshness thresholds or masking stalls |
| Administrators / operators | Interpreting `indexer.status`, paging, restart decisions, incident notes | Assuming data freshness without checking checkpoint age |
| Internal workers / future indexer jobs | Updating the last successful checkpoint accurately | Silently rewriting or suppressing stale-state signals |

### Failure modes and expected client-visible behavior

| Scenario | Expected behavior |
|----------|-------------------|
| Indexer disabled in this environment | `/health` returns `status: "ok"` and `indexer.status: "not_configured"` |
| Indexer enabled but no checkpoint yet | `/health` returns `status: "degraded"` and `indexer.status: "starting"` |
| Indexer checkpoint stale | `/health` returns `status: "degraded"` and `indexer.status: "stalled"` |
| Invalid or unreadable checkpoint value | Treat as `starting`, because the service cannot prove freshness |
| Public HTTP reads while indexer is stalled | Current repo keeps serving its existing responses; operators must treat any future chain-derived views as stale until the checkpoint recovers |
| Dependency outage in a future real indexer | The checkpoint should stop advancing, causing `indexer.status: "stalled"` once the threshold is exceeded |
| Duplicate delivery / duplicated chain event processing | Deferred: no durable indexer or dedupe pipeline exists in this repo version |
| Invalid input to the freshness classifier | The classifier falls back to `starting` rather than pretending the system is healthy |

### Operator runbook

When `indexer.status` becomes `stalled`:

1. Confirm the symptom
   - call `GET /health`
   - record `indexer.lastSuccessfulSyncAt`, `indexer.lagMs`, and `indexer.thresholdMs`
2. Classify customer impact
   - treat chain-derived views as stale
   - do not claim balances, identities, or stream states are current until checkpoint freshness recovers
3. Check the obvious dependency path
   - is the indexer worker enabled
   - is the last successful checkpoint advancing
   - are Stellar RPC, database, or worker logs showing failures
4. Recover
   - restart or unstick the indexer worker if it is wedged
   - restore blocked dependencies
   - confirm `/health` returns `indexer.status: "healthy"` again
5. Close out
   - record the request/incident time window
   - record the stale interval from the last good checkpoint to recovery
   - document follow-up work if recovery required manual intervention

### Abuse and reliability notes

- Invalid checkpoint data must not be treated as healthy.
- Partial data must be called stale rather than silently accepted.
- Duplicate event handling is explicitly deferred until a real indexer exists.
- Excessive request rates are also deferred in this repo version; the runbook documents the stall signal, not rate limiting.

### Operator observability and diagnosis

Operators should be able to answer the following without tribal knowledge:

- whether the indexer is enabled at all
- the exact last successful checkpoint timestamp
- how far the checkpoint lags behind the current wall clock
- whether the service currently considers that lag acceptable
- whether the operator should observe or page immediately

Current operator signals:

- `/health` exposes `indexer.status`
- `/health` exposes `indexer.lastSuccessfulSyncAt`
- `/health` exposes `indexer.lagMs`
- `/health` exposes `indexer.operatorAction`

This is sufficient for a written runbook now. Once a real indexer exists, logs, metrics, and checkpoint persistence should be added to the same contract rather than inventing a second health vocabulary.

### Verification evidence

Automated tests in `src/indexer/stall.test.ts` cover:

- `not_configured` when the indexer is disabled
- `healthy` when the checkpoint is fresh
- `stalled` when the checkpoint breaches the threshold

Build and test verification:

```bash
npm test
npm run build
```

### Non-goals and follow-up work

Intentionally deferred in this issue:

- a real indexer implementation
- persistent checkpoint storage
- restart automation
- alerting integrations
- duplicate-event protection

Recommended follow-up issues:

- implement a real indexer worker and persist its checkpoints
- add health tests around the `/health` route itself once the worker exists
- publish alert thresholds for `indexer.status = "stalled"`
- add rate limiting and duplicate-event handling for the real indexing pipeline

## Project structure

```text
src/
  indexer/        # indexer freshness classification
  routes/         # health and streams routes
  index.ts        # server bootstrap
```

## Environment

Optional:

- `PORT` - server port, default `3000`
- `INDEXER_ENABLED` - whether an indexer is expected in this environment
- `INDEXER_LAST_SUCCESS_AT` - last successful sync checkpoint timestamp
- `INDEXER_STALL_THRESHOLD_MS` - freshness threshold in milliseconds

Likely future additions:

- `DATABASE_URL`
- `REDIS_URL`
- `HORIZON_URL`
- `JWT_SECRET`

## Related repos

- `fluxora-frontend` - dashboard and recipient UI
- `fluxora-contracts` - Soroban smart contracts
