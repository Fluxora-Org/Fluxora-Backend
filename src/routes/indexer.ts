import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  _resetRolledBackLedgers as resetRolledBackLedgerRegistry,
  IndexerIngestionService,
  indexerService,
  isLedgerRolledBack as serviceIsLedgerRolledBack,
  markLedgerRolledBack,
} from '../indexer/service.js';
import type { ReplayRequest } from '../types/index.js';
import {
  InMemoryContractEventStore,
  StaleCursorError,
  type ContractEventStore,
} from '../indexer/store.js';
import type {
  ContractEventRecord,
  IndexerDependencyState,
  IndexerHealthSnapshot,
} from '../indexer/types.js';
import { authenticate, Permission, requireAuth, requirePermission } from '../middleware/auth.js';
import { ApiErrorCode } from '../middleware/errorHandler.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { logger } from '../lib/logger.js';
import { getStreamHub } from '../ws/hub.js';

export const indexerRouter = Router();

const MAX_INDEXER_BATCH_SIZE = 100;
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
const REORG_SAFE_DEPTH = 5;

let eventStore: ContractEventStore = new InMemoryContractEventStore();
let ingestAuthToken = process.env.INDEXER_WORKER_TOKEN ?? 'indexer-worker-token-for-testing-only-12345';
let dependencyState: IndexerDependencyState = 'healthy';
let dependencyReason: string | null = null;
let lastSuccessfulIngestAt: string | null = null;
let lastFailureAt: string | null = null;
let lastFailureReason: string | null = null;
let acceptedBatchCount = 0;
let acceptedEventCount = 0;
let duplicateEventCount = 0;
let lastSafeLedger = 0;
let reorgDetected = false;
let reorgHeight: number | undefined;
let ingestRequestCount = 0;

const contractEventSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  ledger: z.number().int().nonnegative(),
  contractId: z.string().trim().min(1).max(200),
  topic: z.string().trim().min(1).max(200),
  txHash: z.string().trim().min(1).max(200),
  txIndex: z.number().int().nonnegative(),
  operationIndex: z.number().int().nonnegative(),
  eventIndex: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  happenedAt: z.string().datetime(),
  ledgerHash: z.string().trim().min(1).max(200),
});

const ingestBodySchema = z.object({
  events: z.array(contractEventSchema).min(1).max(MAX_INDEXER_BATCH_SIZE),
}).strict();

const replayRequestSchema = z.object({
  contract_id: z.string().trim().min(1),
  ledger: z.number().int().nonnegative(),
  from_block: z.number().int().nonnegative().optional(),
  to_block: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.from_block !== undefined &&
    value.to_block !== undefined &&
    value.from_block > value.to_block
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['from_block'],
      message: 'from_block must be less than or equal to to_block',
    });
  }
});

const eventReplayQuerySchema = z.object({
  fromLedger: z.coerce.number().int().nonnegative().optional(),
  toledger: z.coerce.number().int().nonnegative().optional(),
  contractId: z.string().trim().min(1).optional(),
  topic: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  afterEventId: z.string().trim().min(1).optional(),
}).strict();

function requestId(req: Request): string | undefined {
  return req.id ?? req.correlationId;
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function zodDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function validationEnvelope(res: Response, req: Request, error: z.ZodError): void {
  res.status(400).json(
    errorResponse(ApiErrorCode.VALIDATION_ERROR, 'Validation failed', zodDetails(error), requestId(req)),
  );
}

function requireIndexerWorkerToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-indexer-worker-token');
  if (!token || token !== ingestAuthToken) {
    res.status(401).json(
      errorResponse(ApiErrorCode.UNAUTHORIZED, 'Indexer worker token is required', undefined, requestId(req)),
    );
    return;
  }
  next();
}

function updateLastSafeLedger(events: ContractEventRecord[]): void {
  const maxLedger = events.reduce<number | null>(
    (current, event) => current === null || event.ledger > current ? event.ledger : current,
    null,
  );
  if (maxLedger !== null) {
    lastSafeLedger = Math.max(0, maxLedger - 1);
  }
  if (reorgHeight !== undefined && maxLedger !== null && maxLedger > reorgHeight + REORG_SAFE_DEPTH) {
    reorgDetected = false;
    reorgHeight = undefined;
    resetRolledBackLedgerRegistry();
  }
}

async function applyReorgs(events: ContractEventRecord[]): Promise<void> {
  const rollbackLedgers = new Set<number>();
  for (const event of events) {
    const storedHash = await eventStore.getLedgerHash(event.ledger);
    if (storedHash !== null && storedHash !== event.ledgerHash) {
      rollbackLedgers.add(event.ledger);
    }
  }

  for (const ledger of [...rollbackLedgers].sort((a, b) => a - b)) {
    await eventStore.rollbackBeforeLedger(ledger);
    reorgDetected = true;
    reorgHeight = reorgHeight === undefined ? ledger : Math.min(reorgHeight, ledger);
    markLedgerRolledBack(ledger);
  }
}

function recordFailure(reason: string): void {
  lastFailureAt = new Date().toISOString();
  lastFailureReason = reason;
}

export function setIndexerIngestAuthToken(token: string): void {
  ingestAuthToken = token;
}

export function setIndexerEventStore(store: ContractEventStore): void {
  eventStore = store;
  getStreamHub()?.setEventStore(store);
}

export function setIndexerDependencyState(state: IndexerDependencyState, reason?: string): void {
  dependencyState = state;
  dependencyReason = reason ?? null;
}

export function resetIndexerState(): void {
  eventStore = new InMemoryContractEventStore();
  ingestAuthToken = process.env.INDEXER_WORKER_TOKEN ?? 'indexer-worker-token-for-testing-only-12345';
  dependencyState = 'healthy';
  dependencyReason = null;
  lastSuccessfulIngestAt = null;
  lastFailureAt = null;
  lastFailureReason = null;
  acceptedBatchCount = 0;
  acceptedEventCount = 0;
  duplicateEventCount = 0;
  lastSafeLedger = 0;
  reorgDetected = false;
  reorgHeight = undefined;
  ingestRequestCount = 0;
  resetRolledBackLedgerRegistry();
}

export function getIndexerHealth(): IndexerHealthSnapshot {
  return {
    dependency: dependencyState,
    store: eventStore.kind,
    lastSuccessfulIngestAt,
    lastFailureAt,
    lastFailureReason: lastFailureReason ?? dependencyReason,
    acceptedBatchCount,
    acceptedEventCount,
    duplicateEventCount,
    lastSafeLedger,
    reorgDetected,
    ...(reorgHeight !== undefined ? { reorgHeight } : {}),
  };
}

export function isLedgerRolledBack(ledger: number): boolean {
  return serviceIsLedgerRolledBack(ledger);
}

export function _resetRolledBackLedgers(): void {
  resetRolledBackLedgerRegistry();
}

indexerRouter.post(
  '/contract-events',
  requireIndexerWorkerToken,
  async (req: Request, res: Response): Promise<void> => {
    const correlationId = requestId(req);
    if (dependencyState !== 'healthy') {
      recordFailure(dependencyReason ?? `Indexer dependency is ${dependencyState}`);
      res.status(503).json(
        errorResponse(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Indexer dependency is unavailable',
          dependencyReason ? { reason: dependencyReason } : undefined,
          correlationId,
        ),
      );
      return;
    }

    ingestRequestCount++;
    if (ingestRequestCount > 30) {
      res.status(429).json(
        errorResponse(
          ApiErrorCode.TOO_MANY_REQUESTS,
          'Too many indexer ingest requests',
          { retryAfterSeconds: 60 },
          correlationId,
        ),
      );
      return;
    }

    const parsed = ingestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationEnvelope(res, req, parsed.error);
      return;
    }

    if (parsed.data.events.some((event) => jsonSize(event.payload) > MAX_EVENT_PAYLOAD_BYTES)) {
      recordFailure('payload too large');
      res.status(413).json(
        errorResponse(
          ApiErrorCode.PAYLOAD_TOO_LARGE,
          'Event payload exceeds the configured size limit',
          undefined,
          correlationId,
        ),
      );
      return;
    }

    const ids = new Set<string>();
    const duplicateInBatch = parsed.data.events.find((event) => {
      if (ids.has(event.eventId)) return true;
      ids.add(event.eventId);
      return false;
    });
    if (duplicateInBatch) {
      res.status(409).json(
        errorResponse(
          ApiErrorCode.CONFLICT,
          'Duplicate eventId in batch',
          { eventId: duplicateInBatch.eventId },
          correlationId,
        ),
      );
      return;
    }

    try {
      await applyReorgs(parsed.data.events);
      const result = await new IndexerIngestionService(eventStore).ingest(parsed.data, {
        actor: 'indexer-worker',
      });
      acceptedBatchCount++;
      acceptedEventCount += result.insertedCount;
      duplicateEventCount += result.duplicateCount;
      lastSuccessfulIngestAt = new Date().toISOString();
      updateLastSafeLedger(parsed.data.events);

      const response = {
        outcome: 'persisted' as const,
        insertedCount: result.insertedCount,
        duplicateCount: result.duplicateCount,
        insertedEventIds: result.insertedEventIds,
        duplicateEventIds: result.duplicateEventIds,
      };
      res.json(successResponse(response, correlationId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordFailure(message);
      logger.error('Indexer event ingestion failed', correlationId, { error: message });
      res.status(500).json(
        errorResponse(ApiErrorCode.INTERNAL_ERROR, 'Failed to ingest contract events', undefined, correlationId),
      );
    }
  },
);

indexerRouter.get(
  '/events',
  requireIndexerWorkerToken,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = eventReplayQuerySchema.omit({ afterEventId: true }).safeParse(req.query);
    if (!parsed.success) {
      validationEnvelope(res, req, parsed.error);
      return;
    }

    try {
      const result = await eventStore.getEvents(parsed.data);
      res.json(successResponse(result, requestId(req)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Indexer event listing failed', requestId(req), { error: message });
      res.status(500).json(
        errorResponse(ApiErrorCode.INTERNAL_ERROR, 'Failed to list contract events', undefined, requestId(req)),
      );
    }
  },
);

indexerRouter.get(
  '/events/replay',
  requireIndexerWorkerToken,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = eventReplayQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationEnvelope(res, req, parsed.error);
      return;
    }

    try {
      const result = await eventStore.getEvents(parsed.data);
      res.json(successResponse(result, requestId(req)));
    } catch (error) {
      if (error instanceof StaleCursorError) {
        res.json(successResponse({ events: [], total: 0, limit: parsed.data.limit ?? 100, offset: 0 }, requestId(req)));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Indexer cursor replay failed', requestId(req), { error: message });
      res.status(500).json(
        errorResponse(ApiErrorCode.INTERNAL_ERROR, 'Failed to replay contract events', undefined, requestId(req)),
      );
    }
  },
);

/**
 * Start a historical replay. The router is mounted at `/internal/indexer`,
 * so this relative path serves `POST /internal/indexer/events/replay`.
 */
indexerRouter.post(
  '/events/replay',
  authenticate,
  requireAuth,
  requirePermission(Permission.INDEXER_REPLAY),
  async (req: Request, res: Response): Promise<void> => {
    const correlationId = requestId(req);
    const parsed = replayRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      validationEnvelope(res, req, parsed.error);
      return;
    }

    const replayRequest: ReplayRequest = parsed.data;
    indexerService.replayEvents(replayRequest).catch((error: unknown) => {
      logger.error('Indexer replay failed', correlationId, {
        error: error instanceof Error ? error.message : String(error),
        contract_id: replayRequest.contract_id,
        ledger: replayRequest.ledger,
      });
    });

    res.status(202).json(
      successResponse(
        {
          message: 'Replay started',
          status: indexerService.getReplayProgress(),
        },
        correlationId,
      ),
    );
  },
);

indexerRouter.get('/status', (_req: Request, res: Response) => {
  res.json(successResponse(indexerService.getReplayProgress()));
});
