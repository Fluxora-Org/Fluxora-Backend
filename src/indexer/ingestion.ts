// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.

// ── Ingest service (contract event ingestion from chain worker) ───────────────

import { ApiError, ApiErrorCode, conflictError, serviceUnavailable, validationError } from '../middleware/errorHandler.js';
import { debug, error, info, warn } from '../lib/logger.js';
import { ContractEventStore, InMemoryContractEventStore } from './store.js';
import {
  ContractEventRecord,
  IndexerDependencyState,
  IndexerHealthSnapshot,
  IngestContractEventsRequest,
  IngestContractEventsResult,
} from './types.js';
import { StreamEventReplayFilter, StreamEventReplayResult } from '../db/types.js';
import {
  indexerLedgerLag,
  indexerCatchupEtaSeconds,
} from '../metrics/indexerLag.js';
import {
  indexerEventsIngestedTotal,
  indexerLagSeconds,
} from '../metrics/businessMetrics.js';
import { getStellarRpcService } from '../services/stellar-rpc.js';

function createConcurrencyLimiter(limit: number): { acquire: () => Promise<void>; release: () => void } {
  const waiters: Array<() => void> = [];
  let active = 0;

  return {
    acquire: () =>
      new Promise<void>((resolve) => {
        if (active < limit) {
          active++;
          resolve();
        } else {
          waiters.push(() => {
            active++;
            resolve();
          });
        }
      }),
    release: () => {
      active--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

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

type RateLimitBucket = { timestamps: number[] };
type IngestRequestContext = { actor: string; requestId?: string };

type IndexerState = {
  dependency: IndexerDependencyState;
  lastSuccessfulIngestAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  acceptedBatchCount: number;
  acceptedEventCount: number;
  duplicateEventCount: number;
  lastSafeLedger: number;
  reorgDetected: boolean;
  reorgHeight?: number;
  // Catch-up telemetry state
  lastIndexedLedger: number;
  ledgerLag: number;
  catchupEtaSeconds: number | null;
  ledgerThroughputSamples: number[]; // Rolling window of ledgers/second samples
  lastLedgerLagUpdateAt: number | null;
};

const rolledBackLedgers = new Set<number>();

export function isLedgerRolledBack(ledger: number): boolean {
  return rolledBackLedgers.has(ledger);
}

function clearRolledBackLedger(ledger: number): void {
  rolledBackLedgers.delete(ledger);
}

export function _resetRolledBackLedgers(): void {
  rolledBackLedgers.clear();
}

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
    ledgerHash: assertNonEmptyString(rawEvent.ledgerHash, 'ledgerHash', MAX_TX_HASH_LENGTH),
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
      throw conflictError('request batch contains duplicate eventId values', { eventId: event.eventId });
    }
    seenIds.add(event.eventId);
  }
  return { events };
}

export class IndexerIngestionService {
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  private readonly state: IndexerState;
  private readonly writeSemaphore: { acquire: () => Promise<void>; release: () => void };

  constructor(private store: ContractEventStore) {
    this.state = {
      dependency: 'healthy',
      lastSuccessfulIngestAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      acceptedBatchCount: 0,
      acceptedEventCount: 0,
      duplicateEventCount: 0,
      lastSafeLedger: 0,
      reorgDetected: false,
      // Catch-up telemetry initialization
      lastIndexedLedger: 0,
      ledgerLag: 0,
      catchupEtaSeconds: null,
      ledgerThroughputSamples: [],
      lastLedgerLagUpdateAt: null,
    };
    this.writeSemaphore = createConcurrencyLimiter(4);
  }

  setStore(store: ContractEventStore): void { this.store = store; }

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
    Object.assign(this.state, {
      dependency: 'healthy',
      lastSuccessfulIngestAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      acceptedBatchCount: 0,
      acceptedEventCount: 0,
      duplicateEventCount: 0,
      lastSafeLedger: 0,
      reorgDetected: false,
      reorgHeight: undefined,
      // Reset catch-up telemetry state
      lastIndexedLedger: 0,
      ledgerLag: 0,
      catchupEtaSeconds: null,
      ledgerThroughputSamples: [],
      lastLedgerLagUpdateAt: null,
    });
    rolledBackLedgers.clear();
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
      lastSafeLedger: this.state.lastSafeLedger,
      reorgDetected: this.state.reorgDetected,
    };
  }

  /**
   * Get catch-up telemetry including ledger lag and ETA.
   * This provides visibility into how far behind the indexer is and
   * estimated time to catch up when lagging.
   */
  getCatchupTelemetry(): {
    ledgerLag: number;
    catchupEtaSeconds: number | null;
    lastIndexedLedger: number;
    lastLedgerLagUpdateAt: string | null;
  } {
    return {
      ledgerLag: this.state.ledgerLag,
      catchupEtaSeconds: this.state.catchupEtaSeconds,
      lastIndexedLedger: this.state.lastIndexedLedger,
      lastLedgerLagUpdateAt: this.state.lastLedgerLagUpdateAt
        ? new Date(this.state.lastLedgerLagUpdateAt).toISOString()
        : null,
    };
  }

  /**
   * Compute ledger lag and ETA using the Stellar RPC tip.
   * This should be called periodically (e.g., on each successful ingest)
   * to update catch-up telemetry without making redundant RPC calls.
   *
   * Uses a rolling average of ledger throughput samples to estimate ETA,
   * avoiding naive linear extrapolation from a single sample.
   */
  private async updateCatchupTelemetry(maxLedger: number): Promise<void> {
    try {
      const rpcService = getStellarRpcService();
      const tip = await rpcService.getLatestLedger();
      const tipLedger = tip.sequence;

      // Store previous values before updating
      const previousLedger = this.state.lastIndexedLedger;
      const previousUpdateTime = this.state.lastLedgerLagUpdateAt;

      // Compute ledger lag (tip - last indexed)
      const lag = Math.max(0, tipLedger - maxLedger);
      this.state.ledgerLag = lag;
      this.state.lastIndexedLedger = maxLedger;
      const now = Date.now();
      this.state.lastLedgerLagUpdateAt = now;

      // Update Prometheus gauge
      indexerLedgerLag.set(lag);

      // Compute ETA if lagging and we have throughput data
      if (lag > 0) {
        // Calculate throughput if we have previous data
        if (previousUpdateTime && previousLedger > 0) {
          const timeSinceLastUpdate = (now - previousUpdateTime) / 1000; // seconds

          if (timeSinceLastUpdate > 0) {
            const ledgersProcessed = maxLedger - previousLedger;
            const throughput = ledgersProcessed / timeSinceLastUpdate; // ledgers/second

            // Maintain rolling window of last 10 samples
            this.state.ledgerThroughputSamples.push(throughput);
            if (this.state.ledgerThroughputSamples.length > 10) {
              this.state.ledgerThroughputSamples.shift();
            }

            // Compute average throughput from samples
            const avgThroughput =
              this.state.ledgerThroughputSamples.reduce((sum, sample) => sum + sample, 0) /
              this.state.ledgerThroughputSamples.length;

            // Estimate ETA using average throughput
            if (avgThroughput > 0) {
              const etaSeconds = lag / avgThroughput;
              this.state.catchupEtaSeconds = etaSeconds;
              indexerCatchupEtaSeconds.set(etaSeconds);
            } else {
              this.state.catchupEtaSeconds = null;
              indexerCatchupEtaSeconds.set(0);
            }
          }
        } else {
          // Not enough data for ETA estimation yet
          this.state.catchupEtaSeconds = null;
          indexerCatchupEtaSeconds.set(0);
        }
      } else {
        // Caught up - reset ETA
        this.state.catchupEtaSeconds = null;
        indexerCatchupEtaSeconds.set(0);
      }
    } catch (err) {
      // If RPC fails, we can't compute lag - log but don't fail the ingest
      warn('Failed to update catch-up telemetry (RPC error)', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't update telemetry on RPC failure - keep last known values
    }
  }

  private enforceRateLimit(actor: string): void {
    const now = Date.now();
    const bucket = this.rateLimits.get(actor) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (bucket.timestamps.length >= MAX_RATE_LIMIT_REQUESTS) {
      warn('Indexer ingest rate limit exceeded', { actor, limit: MAX_RATE_LIMIT_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS });
      throw new ApiError(429, ApiErrorCode.TOO_MANY_REQUESTS, 'indexer ingest rate limit exceeded', {
        retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
    }
    bucket.timestamps.push(now);
    this.rateLimits.set(actor, bucket);
  }

  async getEvents(filter?: StreamEventReplayFilter): Promise<StreamEventReplayResult> {
    return this.store.getEvents(filter);
  }

  async ingest(body: unknown, context: IngestRequestContext): Promise<IngestContractEventsResult> {
    if (this.state.dependency !== 'healthy') {
      warn('Indexer dependency unavailable', { actor: context.actor, requestId: context.requestId, state: this.state.dependency });
      throw serviceUnavailable('Indexer event ingestion is temporarily unavailable while the durable store is unhealthy.');
    }
    this.enforceRateLimit(context.actor);
    const request = validateBatch(body);
    const events = request.events;
    const ledgersInBatch = new Set(events.map((e) => e.ledger));

    for (const ledger of ledgersInBatch) {
      const incomingHash = events.find((e) => e.ledger === ledger)!.ledgerHash;
      const existingHash = await this.store.getLedgerHash(ledger);
      if (existingHash && existingHash !== incomingHash) {
        warn('Indexer detected chain reorg', { ledger, existingHash, incomingHash, requestId: context.requestId });
        this.state.reorgDetected = true;
        this.state.reorgHeight = ledger;
        rolledBackLedgers.add(ledger);
        await this.store.rollbackBeforeLedger(ledger);
        this.state.lastFailureAt = new Date().toISOString();
        this.state.lastFailureReason = `Reorg detected at ledger ${ledger}`;
      }
    }

    try {
      await this.writeSemaphore.acquire();
      let result;
      try {
        result = await this.store.insertMany(request.events);
      } finally {
        this.writeSemaphore.release();
      }
      const now = new Date().toISOString();
      const maxLedger = Math.max(...events.map((e) => e.ledger));
      const safeLedger = Math.max(this.state.lastSafeLedger, maxLedger - 1);
      this.state.lastSuccessfulIngestAt = now;
      this.state.acceptedBatchCount += 1;
      this.state.acceptedEventCount += result.insertedEventIds.length;
      this.state.duplicateEventCount += result.duplicateEventIds.length;
      this.state.lastSafeLedger = safeLedger;

      if (this.state.reorgDetected && this.state.reorgHeight !== undefined && maxLedger > this.state.reorgHeight + 5) {
        clearRolledBackLedger(this.state.reorgHeight);
        this.state.reorgDetected = false;
        this.state.reorgHeight = undefined;
      }

      info('Indexer contract event batch persisted', {
        actor: context.actor, requestId: context.requestId, store: this.store.kind,
        batchSize: request.events.length, insertedCount: result.insertedEventIds.length,
        duplicateCount: result.duplicateEventIds.length, lastSafeLedger: this.state.lastSafeLedger,
      });
      debug('Indexer contract event ids processed', {
        requestId: context.requestId, insertedEventIds: result.insertedEventIds, duplicateEventIds: result.duplicateEventIds,
      });

      if (result.insertedEventIds.length > 0) {
        indexerEventsIngestedTotal.inc(result.insertedEventIds.length);

        const latestHappenedAtMs = events.reduce((max, event) => {
          const happenedAtMs = Date.parse(event.happenedAt);
          return Number.isFinite(happenedAtMs) && happenedAtMs > max ? happenedAtMs : max;
        }, 0);
        if (latestHappenedAtMs > 0) {
          indexerLagSeconds.set(Math.max(0, (Date.now() - latestHappenedAtMs) / 1000));
        }

        // Update catch-up telemetry (ledger lag and ETA)
        // This uses the same Stellar RPC tip-fetching path to avoid redundant calls
        await this.updateCatchupTelemetry(maxLedger);
      }

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
      error('Indexer contract event ingest failed', { actor: context.actor, requestId: context.requestId, store: this.store.kind }, err);
      throw serviceUnavailable('Indexer event ingestion could not persist the batch to the durable store.');
    }
  }
}

export const defaultIndexerEventStore = new InMemoryContractEventStore();
export const indexerIngestionService = new IndexerIngestionService(defaultIndexerEventStore);
