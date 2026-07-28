export const DEFAULT_INDEXER_STALL_THRESHOLD_MS = 5 * 60 * 1000;

export type IndexerHealthStatus =
  | 'not_configured'
  | 'starting'
  | 'healthy'
  | 'stalled';

export type AssessIndexerHealthInput = {
  enabled?: boolean;
  lastSuccessfulSyncAt?: string | number | Date | null;
  now?: string | number | Date;
  stallThresholdMs?: number;
};

export type IndexerHealth = {
  status: IndexerHealthStatus;
  stalled: boolean;
  thresholdMs: number;
  lastSuccessfulSyncAt: string | null;
  lagMs: number | null;
  summary: string;
  clientImpact: 'none' | 'stale_chain_state';
  operatorAction: 'none' | 'observe' | 'page';
};

function toTimestamp(value: string | number | Date) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

let isStallLatched = false;
let lastKnownInput: AssessIndexerHealthInput = {};

export function assessIndexerHealth(
  input: AssessIndexerHealthInput = {},
): IndexerHealth {
  // Update cached state if properties are provided
  if (input.enabled !== undefined) lastKnownInput.enabled = input.enabled;
  if (input.lastSuccessfulSyncAt !== undefined) lastKnownInput.lastSuccessfulSyncAt = input.lastSuccessfulSyncAt;
  if (input.stallThresholdMs !== undefined) lastKnownInput.stallThresholdMs = input.stallThresholdMs;

  const thresholdMs = input.stallThresholdMs ?? lastKnownInput.stallThresholdMs ?? DEFAULT_INDEXER_STALL_THRESHOLD_MS;
  const enabled = input.enabled ?? lastKnownInput.enabled ?? false;
  const lastSuccessfulSyncAt = input.lastSuccessfulSyncAt ?? lastKnownInput.lastSuccessfulSyncAt;

  if (!enabled) {
    isStallLatched = false;
    return {
      status: 'not_configured',
      stalled: false,
      thresholdMs,
      lastSuccessfulSyncAt: null,
      lagMs: null,
      summary: 'Indexer is not configured in this environment',
      clientImpact: 'none',
      operatorAction: 'none',
    };
  }

  if (!lastSuccessfulSyncAt) {
    return {
      status: isStallLatched ? 'stalled' : 'starting',
      stalled: isStallLatched,
      thresholdMs,
      lastSuccessfulSyncAt: null,
      lagMs: null,
      summary: isStallLatched
        ? 'Indexer remains stalled (missing sync time)'
        : 'Indexer is enabled but no successful sync has been recorded yet',
      clientImpact: 'stale_chain_state',
      operatorAction: isStallLatched ? 'page' : 'observe',
    };
  }

  const lastSuccessfulSyncAtMs = toTimestamp(lastSuccessfulSyncAt);
  const nowMs = toTimestamp(input.now ?? Date.now()) ?? Date.now();

  if (lastSuccessfulSyncAtMs === null) {
    return {
      status: isStallLatched ? 'stalled' : 'starting',
      stalled: isStallLatched,
      thresholdMs,
      lastSuccessfulSyncAt: null,
      lagMs: null,
      summary: isStallLatched
        ? 'Indexer remains stalled (unreadable sync time)'
        : 'Indexer checkpoint is unreadable; treat the worker as not yet healthy',
      clientImpact: 'stale_chain_state',
      operatorAction: isStallLatched ? 'page' : 'observe',
    };
  }

  const lagMs = Math.max(0, nowMs - lastSuccessfulSyncAtMs);
  const lastSuccessfulSyncAtIso = new Date(lastSuccessfulSyncAtMs).toISOString();

  if (lagMs > thresholdMs) {
    isStallLatched = true;
  }

  if (isStallLatched) {
    return {
      status: 'stalled',
      stalled: true,
      thresholdMs,
      lastSuccessfulSyncAt: lastSuccessfulSyncAtIso,
      lagMs,
      summary: lagMs > thresholdMs
        ? 'Indexer checkpoint is older than the allowed freshness threshold'
        : 'Indexer has recovered but the stall flag remains latched until cleared by an operator',
      clientImpact: 'stale_chain_state',
      operatorAction: 'page',
    };
  }

  return {
    status: 'healthy',
    stalled: false,
    thresholdMs,
    lastSuccessfulSyncAt: lastSuccessfulSyncAtIso,
    lagMs,
    summary: 'Indexer checkpoint is within the allowed freshness threshold',
    clientImpact: 'none',
    operatorAction: 'none',
  };
}

/**
 * Thrown when attempting to clear the stall flag while the indexer is actively lagging.
 */
export class ActiveStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveStallError';
  }
}

/**
 * Operator action to clear a latched stall flag.
 * Refuses to clear if the underlying lag is still violating the threshold.
 *
 * @param input - Optional explicit inputs; otherwise defaults to the last known inputs
 * @throws {ActiveStallError} if the indexer is still actively stalled
 */
export function clearIndexerStall(input: AssessIndexerHealthInput = {}): void {
  const thresholdMs = input.stallThresholdMs ?? lastKnownInput.stallThresholdMs ?? DEFAULT_INDEXER_STALL_THRESHOLD_MS;
  const enabled = input.enabled ?? lastKnownInput.enabled ?? false;
  const lastSuccessfulSyncAt = input.lastSuccessfulSyncAt ?? lastKnownInput.lastSuccessfulSyncAt;

  if (enabled && lastSuccessfulSyncAt) {
    const lastSuccessfulSyncAtMs = toTimestamp(lastSuccessfulSyncAt);
    const nowMs = toTimestamp(input.now ?? Date.now()) ?? Date.now();

    if (lastSuccessfulSyncAtMs !== null) {
      const lagMs = Math.max(0, nowMs - lastSuccessfulSyncAtMs);
      if (lagMs > thresholdMs) {
        throw new ActiveStallError('Cannot clear stall flag: indexer is still actively stalled.');
      }
    }
  }

  isStallLatched = false;
}

/**
 * Resets the internal stall state for test isolation.
 * @internal
 */
export function _resetForTest(): void {
  isStallLatched = false;
  lastKnownInput = {};
}

