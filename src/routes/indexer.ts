/**
 * Indexer routes.
 *
 * Mounted at /internal/indexer in src/app.ts.  All route paths here are
 * relative to that prefix — no duplication.
 *
 * Route inventory:
 *   POST /contract-events          — ingest a batch of chain events (x-indexer-worker-token)
 *   GET  /events/replay            — cursor-paginated replay (x-indexer-worker-token)
 *   GET  /events                   — offset-paginated replay (x-indexer-worker-token)
 *   POST /events/replay            — trigger historical DB replay (JWT + INDEXER_REPLAY)
 *   GET  /status                   — replay progress (JWT + INDEXER_REPLAY)
 *
 * Security:
 *   - /contract-events and /events/* GET routes require the internal x-indexer-worker-token.
 *   - POST /events/replay and GET /status require a JWT with Permission.INDEXER_REPLAY.
 *   - All routes sit behind the shared rate limiter; none are on the public CORS allowlist.
 */
import { Router } from 'express';
import {
  payloadTooLarge,
  unauthorized,
} from '../middleware/errorHandler.js';
import { ContractEventStore, InMemoryContractEventStore } from '../indexer/store.js';
import {
  INDEXER_MAX_EVENTS_PER_BATCH,
  INDEXER_RATE_LIMIT_REQUESTS,
  INDEXER_RATE_LIMIT_WINDOW_MS,
  defaultIndexerEventStore,
  indexerIngestionService,
  indexerService,
} from '../indexer/service.js';
import { IndexerDependencyState } from '../indexer/types.js';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { ReplayRequestSchema, parseBody, formatZodIssues } from '../validation/schemas.js';
import { logger } from '../lib/logger.js';

export const indexerRouter = Router();

// ── Internal worker-token auth ────────────────────────────────────────────────

const INDEXER_AUTH_HEADER = 'x-indexer-worker-token';
let indexerWorkerToken = process.env.INDEXER_WORKER_TOKEN ?? 'fluxora-dev-indexer-token';

function resolveActor(req: any): string {
  const forwardedFor = req.header('x-forwarded-for');
  const remoteAddress = req.ip || req.socket?.remoteAddress || 'unknown';
  return String(forwardedFor ?? remoteAddress);
}

function requireIndexerToken(req: any): void {
  const providedToken = req.header(INDEXER_AUTH_HEADER);
  if (typeof providedToken !== 'string' || providedToken.trim() === '') {
    throw unauthorized('Indexer worker authentication is required');
  }
  if (providedToken.trim() !== indexerWorkerToken) {
    throw unauthorized('Indexer worker authentication failed');
  }
}

function enforceContentLength(req: any): void {
  const header = req.header('content-length');
  if (!header) return;
  const parsed = Number.parseInt(header, 10);
  if (!Number.isNaN(parsed) && parsed > 256 * 1024) {
    throw payloadTooLarge('Indexer ingest payload exceeds the 256 KiB limit');
  }
}

function parseIntParam(val: unknown): number | undefined {
  if (val === undefined || val === '') return undefined;
  const n = Number(val);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// ── POST /contract-events ─────────────────────────────────────────────────────

indexerRouter.post('/contract-events', async (req: any, res: any, next: any) => {
  try {
    requireIndexerToken(req);
    enforceContentLength(req);

    const result = await indexerIngestionService.ingest(req.body, {
      actor: resolveActor(req),
      requestId: req.id ?? req.correlationId,
    });

    res.status(200).json(successResponse({
      outcome: 'persisted',
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      insertedEventIds: result.insertedEventIds,
      duplicateEventIds: result.duplicateEventIds,
    }, req.id ?? req.correlationId));
  } catch (caught) {
    next(caught);
  }
});

// ── GET /events/replay ────────────────────────────────────────────────────────

import { StaleCursorError } from '../indexer/store.js';

indexerRouter.get('/events/replay', async (req: any, res: any, next: any) => {
  try {
    requireIndexerToken(req);

    const afterEventId = typeof req.query.afterEventId === 'string' && req.query.afterEventId !== ''
      ? req.query.afterEventId
      : undefined;

    const filter: import('../db/types.js').StreamEventReplayFilter = {
      ...(afterEventId !== undefined ? { afterEventId } : {}),
      ...(parseIntParam(req.query.fromLedger) !== undefined ? { fromLedger: parseIntParam(req.query.fromLedger) } : {}),
      ...(parseIntParam(req.query.toledger) !== undefined ? { toledger: parseIntParam(req.query.toledger) } : {}),
      ...(typeof req.query.contractId === 'string' ? { contractId: req.query.contractId } : {}),
      ...(typeof req.query.topic === 'string' ? { topic: req.query.topic } : {}),
      ...(parseIntParam(req.query.limit) !== undefined ? { limit: parseIntParam(req.query.limit) } : {}),
    };

    try {
      const result = await indexerIngestionService.getEvents(filter);
      res.status(200).json(successResponse(result, req.id ?? req.correlationId));
    } catch (err) {
      if (err instanceof StaleCursorError) {
        // Unknown cursor = treat as past end of store, return empty
        res.status(200).json(successResponse({ events: [], total: 0, limit: filter.limit ?? 100, offset: 0 }, req.id ?? req.correlationId));
        return;
      }
      throw err;
    }
  } catch (caught) {
    next(caught);
  }
});

// ── GET /events ───────────────────────────────────────────────────────────────

indexerRouter.get('/events', async (req: any, res: any, next: any) => {
  try {
    requireIndexerToken(req);

    const filter: import('../db/types.js').StreamEventReplayFilter = {
      ...(parseIntParam(req.query.fromLedger) !== undefined ? { fromLedger: parseIntParam(req.query.fromLedger) } : {}),
      ...(parseIntParam(req.query.toledger) !== undefined ? { toledger: parseIntParam(req.query.toledger) } : {}),
      ...(typeof req.query.contractId === 'string' ? { contractId: req.query.contractId } : {}),
      ...(typeof req.query.topic === 'string' ? { topic: req.query.topic } : {}),
      ...(parseIntParam(req.query.limit) !== undefined ? { limit: parseIntParam(req.query.limit) } : {}),
      ...(parseIntParam(req.query.offset) !== undefined ? { offset: parseIntParam(req.query.offset) } : {}),
    };

    const result = await indexerIngestionService.getEvents(filter);
    res.status(200).json(successResponse(result, req.id ?? req.correlationId));
  } catch (caught) {
    next(caught);
  }
});

// ── POST /events/replay (JWT + INDEXER_REPLAY) ────────────────────────────────

/**
 * Trigger a historical DB backfill for a given contract / ledger range.
 *
 * @security BearerAuth — requires Permission.INDEXER_REPLAY
 */
indexerRouter.post(
  '/events/replay',
  authenticate,
  requireAuth,
  requirePermission(Permission.INDEXER_REPLAY),
  async (req: any, res: any) => {
    const requestId = req.id ?? req.correlationId;
    const correlationId = req.correlationId;

    const parsed = parseBody(ReplayRequestSchema, req.body);
    if (!parsed.success) {
      res.status(400).json(
        errorResponse('VALIDATION_ERROR', 'Request body validation failed', formatZodIssues(parsed.issues), requestId),
      );
      return;
    }

    const { contract_id, ledger, from_block, to_block } = parsed.data;

    indexerService.replayEvents({ contract_id, ledger, from_block, to_block }).catch((err: unknown) => {
      logger.error('Replay failed', correlationId, {
        contract_id,
        ledger,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('Replay started', correlationId, { contract_id, ledger, from_block, to_block });

    res.status(202).json(
      successResponse({ message: 'Replay started', status: indexerService.getReplayProgress() }, requestId),
    );
  },
);

// ── GET /status (JWT + INDEXER_REPLAY) ───────────────────────────────────────

/**
 * Return current DB replay progress.
 *
 * @security BearerAuth — requires Permission.INDEXER_REPLAY
 */
indexerRouter.get(
  '/status',
  authenticate,
  requireAuth,
  requirePermission(Permission.INDEXER_REPLAY),
  (req: any, res: any) => {
    const requestId = req.id ?? req.correlationId;
    const correlationId = req.correlationId;
    try {
      res.status(200).json(successResponse(indexerService.getReplayProgress(), requestId));
    } catch (err: unknown) {
      logger.error('Failed to get indexer status', correlationId, {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json(errorResponse('INTERNAL_ERROR', 'Failed to get indexer status', undefined, requestId));
    }
  },
);

// ── Test helpers (consumed by tests only) ────────────────────────────────────

export function setIndexerIngestAuthToken(token: string): void {
  indexerWorkerToken = token;
}

export function setIndexerDependencyState(state: IndexerDependencyState, reason?: string): void {
  indexerIngestionService.setDependencyState(state, reason);
}

export function setIndexerEventStore(store: ContractEventStore): void {
  indexerIngestionService.setStore(store);
}

export function resetIndexerState(): void {
  if (defaultIndexerEventStore instanceof InMemoryContractEventStore) {
    defaultIndexerEventStore.reset();
  }
  indexerIngestionService.setStore(defaultIndexerEventStore);
  indexerIngestionService.resetRuntimeState();
  indexerWorkerToken = process.env.INDEXER_WORKER_TOKEN ?? 'fluxora-dev-indexer-token';
}

export function getIndexerHealth() {
  return {
    ...indexerIngestionService.getHealthSnapshot(),
    authHeader: INDEXER_AUTH_HEADER,
    maxBatchSize: INDEXER_MAX_EVENTS_PER_BATCH,
    rateLimit: {
      requests: INDEXER_RATE_LIMIT_REQUESTS,
      windowMs: INDEXER_RATE_LIMIT_WINDOW_MS,
    },
  };
}
