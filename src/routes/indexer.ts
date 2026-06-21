import { Router, type Request, type Response, type NextFunction } from 'express';
import { indexerService } from '../indexer/service';
import {
  _resetRolledBackLedgers,
  pruneRolledBackLedgersAt,
  recordRolledBackLedgers,
} from '../indexer/service.js';
import {
  InMemoryContractEventStore,
  type ContractEventStore,
  type StaleCursorError,
} from '../indexer/store.js';
import {
  type ContractEventRecord,
  type IndexerDependencyState,
  type IndexerHealthSnapshot,
} from '../indexer/types.js';
import { getStreamHub } from '../ws/hub.js';
import { ReplayRequest } from '../types';
import { errorResponse, successResponse } from '../utils/response.js';
import {
  indexerEventsIngestedTotal,
  indexerLagSeconds,
} from '../metrics/businessMetrics.js';

export const indexerRouter = Router();

const MAX_BATCH_EVENTS = 100;
const INGEST_RATE_LIMIT = 30;
const INGEST_RATE_WINDOW_MS = 60_000;
const REORG_ACTIVE_DEPTH = 5;

let eventStore: ContractEventStore = new InMemoryContractEventStore();
let ingestAuthToken = process.env.INDEXER_WORKER_TOKEN ?? 'test-indexer-token';
let dependencyState: IndexerDependencyState = 'healthy';
let dependencyReason: string | null = null;
let lastSuccessfulIngestAt: string | null = null;
let lastFailureAt: string | null = null;
let lastFailureReason: string | null = null;
let acceptedBatchCount = 0;
let acceptedEventCount = 0;
let duplicateEventCount = 0;
let highestLedger = 0;
let reorgHeight: number | undefined;
let ingestWindowStartedAt = Date.now();
let ingestWindowCount = 0;

export function setIndexerEventStore(store: ContractEventStore): void {
  eventStore = store;
  getStreamHub()?.setEventStore(store);
}

export function setIndexerIngestAuthToken(token: string): void {
  ingestAuthToken = token;
}

export function setIndexerDependencyState(
  state: IndexerDependencyState,
  reason: string | null = null,
): void {
  dependencyState = state;
  dependencyReason = reason;
}

export function resetIndexerState(): void {
  eventStore = new InMemoryContractEventStore();
  getStreamHub()?.setEventStore(eventStore);
  dependencyState = 'healthy';
  dependencyReason = null;
  lastSuccessfulIngestAt = null;
  lastFailureAt = null;
  lastFailureReason = null;
  acceptedBatchCount = 0;
  acceptedEventCount = 0;
  duplicateEventCount = 0;
  highestLedger = 0;
  reorgHeight = undefined;
  ingestWindowStartedAt = Date.now();
  ingestWindowCount = 0;
  _resetRolledBackLedgers();
}

export function getIndexerHealth(): IndexerHealthSnapshot {
  const reorgDetected =
    reorgHeight !== undefined && highestLedger <= reorgHeight + REORG_ACTIVE_DEPTH;

  return {
    dependency: dependencyState,
    store: eventStore.kind,
    lastSuccessfulIngestAt,
    lastFailureAt,
    lastFailureReason: dependencyReason ?? lastFailureReason,
    acceptedBatchCount,
    acceptedEventCount,
    duplicateEventCount,
    lastSafeLedger: highestLedger > 0 ? highestLedger - 1 : 0,
    reorgDetected,
    ...(reorgDetected && reorgHeight !== undefined ? { reorgHeight } : {}),
  };
}

function requireIndexerToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-indexer-worker-token');
  if (!token || token !== ingestAuthToken) {
    res.status(401).json(errorResponse('UNAUTHORIZED', 'Invalid indexer worker token', undefined, req.id));
    return;
  }
  next();
}

function enforceIngestRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  if (now - ingestWindowStartedAt >= INGEST_RATE_WINDOW_MS) {
    ingestWindowStartedAt = now;
    ingestWindowCount = 0;
  }

  if (ingestWindowCount >= INGEST_RATE_LIMIT) {
    res.status(429).json(
      errorResponse(
        'TOO_MANY_REQUESTS',
        'Indexer ingest rate limit exceeded',
        { retryAfterSeconds: Math.ceil((INGEST_RATE_WINDOW_MS - (now - ingestWindowStartedAt)) / 1000) },
        req.id,
      ),
    );
    return;
  }

  ingestWindowCount++;
  next();
}

function failIndexerDependency(req: Request, res: Response): boolean {
  if (dependencyState === 'healthy') {
    return false;
  }

  res.status(503).json(
    errorResponse(
      'SERVICE_UNAVAILABLE',
      dependencyReason ?? 'Indexer dependency is unavailable',
      { dependency: dependencyState },
      req.id,
    ),
  );
  return true;
}

function validateEvent(value: unknown, seen: Set<string>): ContractEventRecord | { error: string; status?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'Each event must be an object' };
  }

  const raw = value as Record<string, unknown>;
  const eventId = raw['eventId'];
  const ledger = raw['ledger'];
  const payload = raw['payload'];

  if (typeof eventId !== 'string' || eventId.trim() === '') {
    return { error: 'eventId must be a non-empty string' };
  }
  if (seen.has(eventId)) {
    return { error: 'Duplicate eventId in batch', status: 409 };
  }
  if (typeof ledger !== 'number' || !Number.isFinite(ledger) || ledger < 0) {
    return { error: 'ledger must be a non-negative number' };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { error: 'payload must be an object' };
  }

  for (const field of ['contractId', 'topic', 'txHash', 'happenedAt', 'ledgerHash'] as const) {
    if (typeof raw[field] !== 'string' || (raw[field] as string).trim() === '') {
      return { error: `${field} must be a non-empty string` };
    }
  }

  for (const field of ['txIndex', 'operationIndex', 'eventIndex'] as const) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
      return { error: `${field} must be a number` };
    }
  }

  seen.add(eventId);
  return {
    eventId,
    ledger,
    contractId: raw['contractId'] as string,
    topic: raw['topic'] as string,
    txHash: raw['txHash'] as string,
    txIndex: raw['txIndex'] as number,
    operationIndex: raw['operationIndex'] as number,
    eventIndex: raw['eventIndex'] as number,
    payload: payload as Record<string, unknown>,
    happenedAt: raw['happenedAt'] as string,
    ledgerHash: raw['ledgerHash'] as string,
  };
}

async function detectAndApplyReorg(events: ContractEventRecord[]): Promise<void> {
  let earliestFork: {
    ledger: number;
    evictedHash: string;
    incomingHash: string;
  } | null = null;

  for (const event of events) {
    const existingHash = await eventStore.getLedgerHash(event.ledger);
    if (existingHash !== null && existingHash !== event.ledgerHash) {
      if (earliestFork === null || event.ledger < earliestFork.ledger) {
        earliestFork = {
          ledger: event.ledger,
          evictedHash: existingHash,
          incomingHash: event.ledgerHash,
        };
      }
    }
  }

  if (!earliestFork) {
    return;
  }

  const beforeRollback = await eventStore.getEvents({ fromLedger: earliestFork.ledger, limit: 1000 });
  const rolledBackTip = beforeRollback.events.reduce(
    (max, event) => Math.max(max, event.ledger),
    earliestFork.ledger,
  );

  await eventStore.rollbackBeforeLedger(earliestFork.ledger);
  reorgHeight = earliestFork.ledger;
  recordRolledBackLedgers({
    fromLedger: earliestFork.ledger,
    toLedger: rolledBackTip,
    observedAtLedger: Math.max(rolledBackTip, ...events.map((event) => event.ledger)),
    evictedHash: earliestFork.evictedHash,
    incomingHash: earliestFork.incomingHash,
  });
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function buildReplayFilter(req: Request): Parameters<ContractEventStore['getEvents']>[0] {
  const filter: Parameters<ContractEventStore['getEvents']>[0] = {};

  if (req.query['fromLedger'] !== undefined) {
    filter.fromLedger = parsePositiveInteger(req.query['fromLedger'], 0);
  }
  if (req.query['toledger'] !== undefined) {
    filter.toledger = parsePositiveInteger(req.query['toledger'], 0);
  }
  if (typeof req.query['contractId'] === 'string') {
    filter.contractId = req.query['contractId'];
  }
  if (typeof req.query['topic'] === 'string') {
    filter.topic = req.query['topic'];
  }
  if (typeof req.query['afterEventId'] === 'string') {
    filter.afterEventId = req.query['afterEventId'];
  }
  if (req.query['limit'] !== undefined) {
    filter.limit = parsePositiveInteger(req.query['limit'], 100);
  }
  if (req.query['offset'] !== undefined) {
    filter.offset = parsePositiveInteger(req.query['offset'], 0);
  }

  return filter;
}

indexerRouter.post(
  ['/contract-events', '/internal/indexer/contract-events'],
  requireIndexerToken,
  enforceIngestRateLimit,
  async (req: Request, res: Response): Promise<void> => {
    if (failIndexerDependency(req, res)) {
      return;
    }

    if (typeof req.body !== 'object' || req.body === null || !Array.isArray(req.body.events)) {
      res.status(400).json(errorResponse('VALIDATION_ERROR', 'events must be an array', undefined, req.id));
      return;
    }
    if (req.body.events.length === 0 || req.body.events.length > MAX_BATCH_EVENTS) {
      res.status(400).json(
        errorResponse('VALIDATION_ERROR', `events must contain 1-${MAX_BATCH_EVENTS} entries`, undefined, req.id),
      );
      return;
    }

    const seen = new Set<string>();
    const events: ContractEventRecord[] = [];
    for (const rawEvent of req.body.events) {
      const event = validateEvent(rawEvent, seen);
      if ('error' in event) {
        const status = event.status ?? 400;
        res.status(status).json(
          errorResponse(status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR', event.error, undefined, req.id),
        );
        return;
      }
      events.push(event);
    }

    try {
      await detectAndApplyReorg(events);
      const result = await eventStore.insertMany(events);
      const insertedCount = result.insertedEventIds.length;
      const duplicateCount = result.duplicateEventIds.length;

      acceptedBatchCount++;
      acceptedEventCount += insertedCount;
      duplicateEventCount += duplicateCount;
      highestLedger = Math.max(highestLedger, ...events.map((event) => event.ledger));
      pruneRolledBackLedgersAt(highestLedger);
      lastSuccessfulIngestAt = new Date().toISOString();

      if (insertedCount > 0) {
        indexerEventsIngestedTotal.inc(insertedCount);
        const newestInsertedEvent = events
          .filter((event) => result.insertedEventIds.includes(event.eventId))
          .sort((a, b) => b.ledger - a.ledger)[0];
        if (newestInsertedEvent) {
          const lagSeconds = Math.max(
            0,
            (Date.now() - new Date(newestInsertedEvent.happenedAt).getTime()) / 1000,
          );
          indexerLagSeconds.set(lagSeconds);
        }
      }

      res.json(
        successResponse(
          {
            outcome: insertedCount > 0 ? 'persisted' : 'duplicate',
            insertedCount,
            duplicateCount,
            insertedEventIds: result.insertedEventIds,
            duplicateEventIds: result.duplicateEventIds,
          },
          req.id,
        ),
      );
    } catch (error) {
      lastFailureAt = new Date().toISOString();
      lastFailureReason = error instanceof Error ? error.message : String(error);
      res.status(500).json(errorResponse('INTERNAL_ERROR', 'Failed to ingest indexer events', undefined, req.id));
    }
  },
);

indexerRouter.get(
  ['/events', '/events/replay', '/internal/indexer/events', '/internal/indexer/events/replay'],
  requireIndexerToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await eventStore.getEvents(buildReplayFilter(req));
      res.json(successResponse(result, req.id));
    } catch (error) {
      if ((error as StaleCursorError & { code?: string }).code === 'STALE_CURSOR') {
        res.json(
          successResponse(
            { events: [], total: 0, limit: parsePositiveInteger(req.query['limit'], 100), offset: 0 },
            req.id,
          ),
        );
        return;
      }
      res.status(500).json(errorResponse('INTERNAL_ERROR', 'Failed to replay indexer events', undefined, req.id));
    }
  },
);

/**
 * POST /internal/indexer/events/replay/start
 *
 * Replay historical contract events into contract_events table. The route is
 * kept separate from the cursor replay GET endpoint above.
 */
indexerRouter.post(
  ['/events/replay/start', '/internal/indexer/events/replay/start'],
  requireIndexerToken,
  async (req: Request, res: Response) => {
    try {
      const request: ReplayRequest = {
        contract_id: req.body.contract_id,
        ledger: req.body.ledger,
        from_block: req.body.from_block,
        to_block: req.body.to_block,
      };

      indexerService.replayEvents(request).catch((error) => {
        console.error('Replay failed:', error);
      });

      res.status(202).json({
        message: 'Replay started',
        status: indexerService.getReplayProgress(),
      });
    } catch (error: unknown) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to start replay',
      });
    }
  },
);

indexerRouter.get(['/status', '/internal/indexer/status'], (_req: Request, res: Response) => {
  try {
    const progress = indexerService.getReplayProgress();
    res.status(200).json({ ...getIndexerHealth(), replay: progress });
  } catch (error: unknown) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get indexer status',
    });
  }
});
