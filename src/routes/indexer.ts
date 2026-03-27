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
} from '../indexer/service.js';
import { IndexerDependencyState } from '../indexer/types.js';

export const indexerRouter = Router();

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
  if (!header) {
    return;
  }

  const parsed = Number.parseInt(header, 10);
  if (Number.isNaN(parsed)) {
    return;
  }

  if (parsed > 256 * 1024) {
    throw payloadTooLarge('Indexer ingest payload exceeds the 256 KiB limit');
  }
}

/**
 * @openapi
 * /internal/indexer/contract-events:
 *   post:
 *     summary: Persist a batch of contract events into the durable Postgres view
 *     description: |
 *       Internal-only endpoint used by the indexer worker after it has read events from the chain.
 *
 *       Service-level outcomes:
 *       - A 200 response means the batch has been durably written to the configured event store.
 *       - Duplicate deliveries are absorbed by `eventId` uniqueness and returned in the response body.
 *       - Invalid batches fail atomically and write nothing.
 *       - If the durable store is degraded or unavailable, the service fails closed with 503.
 *
 *       Trust boundaries:
 *       - Public internet clients may not call this route.
 *       - Authenticated internal workers may submit contract-event batches only.
 *       - Administrators observe health and failures via `/health`, request IDs, and structured logs.
 *       - Internal workers do not receive privileged database internals in responses.
 *     tags:
 *       - indexer
 *     parameters:
 *       - name: x-indexer-worker-token
 *         in: header
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - events
 *             properties:
 *               events:
 *                 type: array
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Batch persisted
 *       401:
 *         description: Missing or invalid internal worker credentials
 *       409:
 *         description: Duplicate event identifiers within the submitted batch
 *       413:
 *         description: Payload too large
 *       429:
 *         description: Internal worker exceeded allowed ingest rate
 *       503:
 *         description: Durable store unavailable
 */
indexerRouter.post('/contract-events', async (req: any, res: any, next: any) => {
  try {
    requireIndexerToken(req);
    enforceContentLength(req);

    const result = await indexerIngestionService.ingest(req.body, {
      actor: resolveActor(req),
      requestId: req.id ?? req.correlationId,
    });

    res.status(200).json({
      outcome: 'persisted',
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      insertedEventIds: result.insertedEventIds,
      duplicateEventIds: result.duplicateEventIds,
    });
  } catch (caught) {
    next(caught);
  }
});

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
