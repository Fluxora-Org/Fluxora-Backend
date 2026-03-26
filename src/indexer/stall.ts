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

export function assessIndexerHealth(
  input: AssessIndexerHealthInput = {},
): IndexerHealth {
  const thresholdMs = input.stallThresholdMs ?? DEFAULT_INDEXER_STALL_THRESHOLD_MS;
  const enabled = input.enabled ?? false;

  if (!enabled) {
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

  if (!input.lastSuccessfulSyncAt) {
    return {
      status: 'starting',
      stalled: false,
      thresholdMs,
      lastSuccessfulSyncAt: null,
      lagMs: null,
      summary: 'Indexer is enabled but no successful sync has been recorded yet',
      clientImpact: 'stale_chain_state',
      operatorAction: 'observe',
    };
  }

  const lastSuccessfulSyncAtMs = toTimestamp(input.lastSuccessfulSyncAt);
  const nowMs = toTimestamp(input.now ?? Date.now()) ?? Date.now();

  if (lastSuccessfulSyncAtMs === null) {
    return {
      status: 'starting',
      stalled: false,
      thresholdMs,
      lastSuccessfulSyncAt: null,
      lagMs: null,
      summary: 'Indexer checkpoint is unreadable; treat the worker as not yet healthy',
      clientImpact: 'stale_chain_state',
      operatorAction: 'observe',
    };
  }

  const lagMs = Math.max(0, nowMs - lastSuccessfulSyncAtMs);
  const lastSuccessfulSyncAtIso = new Date(lastSuccessfulSyncAtMs).toISOString();

  if (lagMs > thresholdMs) {
    return {
      status: 'stalled',
      stalled: true,
      thresholdMs,
      lastSuccessfulSyncAt: lastSuccessfulSyncAtIso,
      lagMs,
      summary: 'Indexer checkpoint is older than the allowed freshness threshold',
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
