import { ApiError, ApiErrorCode, conflictError, serviceUnavailable, validationError } from '../middleware/errorHandler.js';
import { debug, error, info, warn } from '../utils/logger.js';
import { ContractEventStore, InMemoryContractEventStore } from './store.js';
import {
  ContractEventRecord,
  IndexerDependencyState,
  IndexerHealthSnapshot,
  IngestContractEventsRequest,
  IngestContractEventsResult,
} from './types.js';

const MAX_EVENTS_PER_BATCH = 100;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_TOPIC_LENGTH = 128;
const MAX_CONTRACT_ID_LENGTH = 128;
const MAX_TX_HASH_LENGTH = 128;
const MAX_RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const INDEXER_MAX_EVENTS_PER_BATCH = MAX_EVENTS_PER_BATCH;
export const INDEXER_RATE_LIMIT_REQUESTS = MAX_RATE_LIMIT_REQUESTS;
export const INDEXER_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;

type RateLimitBucket = {
  timestamps: number[];
};

type IngestRequestContext = {
  actor: string;
  requestId?: string;
};

type IndexerState = {
  dependency: IndexerDependencyState;
  lastSuccessfulIngestAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  acceptedBatchCount: number;
  acceptedEventCount: number;
  duplicateEventCount: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${field} must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw validationError(`${field} must not exceed ${maxLength} characters`);
  }

  return trimmed;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw validationError(`${field} must be a non-negative integer`);
  }

  return value;
}

function assertIsoTimestamp(value: unknown, field: string): string {
  const timestamp = assertNonEmptyString(value, field);
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw validationError(`${field} must be a valid ISO-8601 timestamp`);
  }

  return new Date(parsed).toISOString();
}

function validateEvent(rawEvent: unknown): ContractEventRecord {
  if (!isPlainObject(rawEvent)) {
    throw validationError('each event must be an object');
  }

  const payload = rawEvent.payload;
  if (!isPlainObject(payload)) {
    throw validationError('payload must be a JSON object');
  }

  return {
    eventId: assertNonEmptyString(rawEvent.eventId, 'eventId', MAX_EVENT_ID_LENGTH),
    ledger: assertNonNegativeInteger(rawEvent.ledger, 'ledger'),
    contractId: assertNonEmptyString(rawEvent.contractId, 'contractId', MAX_CONTRACT_ID_LENGTH),
    topic: assertNonEmptyString(rawEvent.topic, 'topic', MAX_TOPIC_LENGTH),
    txHash: assertNonEmptyString(rawEvent.txHash, 'txHash', MAX_TX_HASH_LENGTH),
    txIndex: assertNonNegativeInteger(rawEvent.txIndex, 'txIndex'),
    operationIndex: assertNonNegativeInteger(rawEvent.operationIndex, 'operationIndex'),
    eventIndex: assertNonNegativeInteger(rawEvent.eventIndex, 'eventIndex'),
    payload,
    happenedAt: assertIsoTimestamp(rawEvent.happenedAt, 'happenedAt'),
  };
}

function validateBatch(body: unknown): IngestContractEventsRequest {
  if (!isPlainObject(body)) {
    throw validationError('request body must be an object');
  }

  if (!Array.isArray(body.events)) {
    throw validationError('events must be an array');
  }

  if (body.events.length < 1) {
    throw validationError('events must contain at least one contract event');
  }

  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    throw validationError(`events must not contain more than ${MAX_EVENTS_PER_BATCH} items`);
  }

  const events = body.events.map((event) => validateEvent(event));
  const seenIds = new Set<string>();

  for (const event of events) {
    if (seenIds.has(event.eventId)) {
      throw conflictError('request batch contains duplicate eventId values', {
        eventId: event.eventId,
      });
    }
    seenIds.add(event.eventId);
  }

  return { events };
}

export class IndexerIngestionService {
  private readonly rateLimits = new Map<string, RateLimitBucket>();

  private readonly state: IndexerState;

  constructor(private store: ContractEventStore) {
    this.state = {
      dependency: 'healthy',
      lastSuccessfulIngestAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      acceptedBatchCount: 0,
      acceptedEventCount: 0,
      duplicateEventCount: 0,
    };
  }

  setStore(store: ContractEventStore): void {
    this.store = store;
  }

  setDependencyState(state: IndexerDependencyState, reason?: string): void {
    this.state.dependency = state;
    if (state !== 'healthy') {
      this.state.lastFailureAt = new Date().toISOString();
      this.state.lastFailureReason = reason ?? 'dependency marked degraded';
    } else {
      this.state.lastFailureReason = null;
    }
  }

  resetRuntimeState(): void {
    this.rateLimits.clear();
    this.state.dependency = 'healthy';
    this.state.lastSuccessfulIngestAt = null;
    this.state.lastFailureAt = null;
    this.state.lastFailureReason = null;
    this.state.acceptedBatchCount = 0;
    this.state.acceptedEventCount = 0;
    this.state.duplicateEventCount = 0;
  }

  getHealthSnapshot(): IndexerHealthSnapshot {
    return {
      dependency: this.state.dependency,
      store: this.store.kind,
      lastSuccessfulIngestAt: this.state.lastSuccessfulIngestAt,
      lastFailureAt: this.state.lastFailureAt,
      lastFailureReason: this.state.lastFailureReason,
      acceptedBatchCount: this.state.acceptedBatchCount,
      acceptedEventCount: this.state.acceptedEventCount,
      duplicateEventCount: this.state.duplicateEventCount,
    };
  }

  private enforceRateLimit(actor: string): void {
    const now = Date.now();
    const bucket = this.rateLimits.get(actor) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

    if (bucket.timestamps.length >= MAX_RATE_LIMIT_REQUESTS) {
      warn('Indexer ingest rate limit exceeded', {
        actor,
        limit: MAX_RATE_LIMIT_REQUESTS,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });
      throw new ApiError(ApiErrorCode.TOO_MANY_REQUESTS, 'indexer ingest rate limit exceeded', 429, {
        retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
    }

    bucket.timestamps.push(now);
    this.rateLimits.set(actor, bucket);
  }

  async ingest(body: unknown, context: IngestRequestContext): Promise<IngestContractEventsResult> {
    if (this.state.dependency !== 'healthy') {
      warn('Indexer dependency unavailable', {
        dependency: 'postgres-contract-events',
        actor: context.actor,
        requestId: context.requestId,
        state: this.state.dependency,
      });
      throw serviceUnavailable('Indexer event ingestion is temporarily unavailable while the durable store is unhealthy.');
    }

    this.enforceRateLimit(context.actor);

    const request = validateBatch(body);

    try {
      const result = await this.store.insertMany(request.events);
      const now = new Date().toISOString();

      this.state.lastSuccessfulIngestAt = now;
      this.state.acceptedBatchCount += 1;
      this.state.acceptedEventCount += result.insertedEventIds.length;
      this.state.duplicateEventCount += result.duplicateEventIds.length;

      info('Indexer contract event batch persisted', {
        actor: context.actor,
        requestId: context.requestId,
        store: this.store.kind,
        batchSize: request.events.length,
        insertedCount: result.insertedEventIds.length,
        duplicateCount: result.duplicateEventIds.length,
      });

      debug('Indexer contract event ids processed', {
        requestId: context.requestId,
        insertedEventIds: result.insertedEventIds,
        duplicateEventIds: result.duplicateEventIds,
      });

      return {
        insertedCount: result.insertedEventIds.length,
        duplicateCount: result.duplicateEventIds.length,
        insertedEventIds: result.insertedEventIds,
        duplicateEventIds: result.duplicateEventIds,
      };
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error('Unknown indexer ingest failure');
      this.state.lastFailureAt = new Date().toISOString();
      this.state.lastFailureReason = err.message;
      error('Indexer contract event ingest failed', {
        actor: context.actor,
        requestId: context.requestId,
        store: this.store.kind,
      }, err);
      throw serviceUnavailable('Indexer event ingestion could not persist the batch to the durable store.');
    }
  }
}

export const defaultIndexerEventStore = new InMemoryContractEventStore();
export const indexerIngestionService = new IndexerIngestionService(defaultIndexerEventStore);
