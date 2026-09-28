export const CHAIN_STREAM_STATUSES = [
  'pending',
  'active',
  'paused',
  'completed',
  'cancelled',
  'depleted',
] as const;

export const API_STREAM_STATUSES = [
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;

export type ChainStreamStatus = (typeof CHAIN_STREAM_STATUSES)[number];
export type ApiStreamStatus = (typeof API_STREAM_STATUSES)[number];

export type StreamStatusMapping = {
  chainStatus: ChainStreamStatus;
  status: ApiStreamStatus;
  terminal: boolean;
  statusReason?: 'depleted';
};

const CHAIN_TO_API_STATUS: Record<ChainStreamStatus, Omit<StreamStatusMapping, 'chainStatus'>> = {
  pending: {
    status: 'active',
    terminal: false,
  },
  active: {
    status: 'active',
    terminal: false,
  },
  paused: {
    status: 'paused',
    terminal: false,
  },
  completed: {
    status: 'completed',
    terminal: true,
  },
  cancelled: {
    status: 'cancelled',
    terminal: true,
  },
  depleted: {
    status: 'completed',
    terminal: true,
    statusReason: 'depleted',
  },
};

export function isChainStreamStatus(value: unknown): value is ChainStreamStatus {
  return typeof value === 'string' &&
    (CHAIN_STREAM_STATUSES as readonly string[]).includes(value);
}

export function isApiStreamStatus(value: unknown): value is ApiStreamStatus {
  return typeof value === 'string' &&
    (API_STREAM_STATUSES as readonly string[]).includes(value);
}

export function defaultChainStatusForStartTime(
  startTime: number,
  now = Math.floor(Date.now() / 1000),
): ChainStreamStatus {
  return startTime > now ? 'pending' : 'active';
}

export function mapChainStatusToApiStatus(
  chainStatus: ChainStreamStatus,
): StreamStatusMapping {
  return {
    chainStatus,
    ...CHAIN_TO_API_STATUS[chainStatus],
  };
}

/**
 * Valid API-layer status transitions.
 * Terminal statuses (completed, cancelled) have no outgoing edges.
 */
export const VALID_API_TRANSITIONS: Record<ApiStreamStatus, readonly ApiStreamStatus[]> = {
  active:    ['paused', 'completed', 'cancelled'],
  paused:    ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

/**
 * Returns true when the given API status is terminal (completed or cancelled).
 * Terminal streams are immutable and safe to cache at the edge.
 */
export function isTerminalStatus(status: ReportedStreamStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Returns true when moving from `from` → `to` is a permitted transition.
 */
export function isValidApiTransition(from: ApiStreamStatus, to: ApiStreamStatus): boolean {
  return (VALID_API_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Asserts the transition is valid and returns a descriptive error message when
 * it is not, so callers can surface a 409 without duplicating the logic.
 */
export function assertValidApiTransition(
  from: ApiStreamStatus,
  to: ApiStreamStatus,
): { ok: true } | { ok: false; message: string } {
  if (isValidApiTransition(from, to)) return { ok: true };
  const terminal = VALID_API_TRANSITIONS[from]?.length === 0;
  const message = terminal
    ? `Stream is already ${from} and cannot be transitioned`
    : `Cannot transition stream from '${from}' to '${to}'`;
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Derived stream status
// ---------------------------------------------------------------------------
//
// Everything the API reports about a stream's status flows through
// `deriveStreamStatus`. The chain is the single source of truth: the reported
// status is a pure function of the chain observation, never of local state,
// and it is never guessed. When the chain value cannot be interpreted the
// caller is told `unknown`, and the age of the observation is always surfaced
// so a stale read is visible rather than silently presented as current.

/**
 * The status the API reports for a stream. `unknown` is deliberately outside
 * `API_STREAM_STATUSES`: it is not a chain state, it is the honest answer when
 * the chain state cannot be interpreted.
 */
export type ReportedStreamStatus = ApiStreamStatus | 'unknown';

/** How old a chain observation may be before it is reported as stale. */
export const DEFAULT_MAX_STALENESS_SECONDS = 5 * 60;

/** A status read from the chain, plus when it was read. */
export interface ChainStateObservation {
  /**
   * Raw status as read from the chain. Typed `unknown` on purpose: it is not
   * trusted until validated, so a new or unexpected chain value degrades to
   * `unknown` instead of being coerced into an API status.
   */
  chainStatus: unknown;
  /** Unix seconds at which the chain was read. */
  observedAt: number;
  /** Ledger the observation was read at, echoed back to the caller. */
  ledger?: number;
  /** Injected clock (unix seconds). Defaults to the wall clock. */
  now?: number;
  /** Age (seconds) beyond which the observation is reported as stale. */
  maxStalenessSeconds?: number;
}

/** The status derived from a single chain observation. */
export interface DerivedStreamStatus {
  status: ReportedStreamStatus;
  /** True when the stream cannot leave this status (completed / cancelled). */
  terminal: boolean;
  /** Present only when the chain state carried extra meaning (depleted). */
  statusReason?: 'depleted';
  /** The validated chain status behind `status`, or null when unrecognised. */
  chainStatus: ChainStreamStatus | null;
  /** Always `chain`: the status is derived, never invented locally. */
  source: 'chain';
  /** True when the observation is older than the staleness threshold. */
  stale: boolean;
  /** Age of the observation in seconds, clamped at 0 for future timestamps. */
  ageSeconds: number;
  /** Unix seconds at which the chain was read. */
  observedAt: number;
  /** Ledger the observation came from, when the caller supplied one. */
  ledger?: number;
}

export function isReportedStreamStatus(value: unknown): value is ReportedStreamStatus {
  return value === 'unknown' ||
    (API_STREAM_STATUSES as readonly string[]).includes(value as string);
}

/**
 * Derive the status the API should report for a chain observation.
 *
 * This is the single source of status derivation: callers must not map chain
 * values themselves, because a second mapping is exactly how the API drifts
 * from the chain. Unrecognised chain values yield `status: 'unknown'`,
 * `terminal: false` and `chainStatus: null`.
 */
export function deriveStreamStatus(observation: ChainStateObservation): DerivedStreamStatus {
  const now = observation.now ?? Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - observation.observedAt);
  const maxStaleness = observation.maxStalenessSeconds ?? DEFAULT_MAX_STALENESS_SECONDS;
  const stale = ageSeconds > maxStaleness;

  if (!isChainStreamStatus(observation.chainStatus)) {
    return {
      status: 'unknown',
      terminal: false,
      chainStatus: null,
      source: 'chain',
      stale,
      ageSeconds,
      observedAt: observation.observedAt,
      ledger: observation.ledger,
    };
  }

  const mapping = mapChainStatusToApiStatus(observation.chainStatus);
  return {
    status: mapping.status,
    terminal: mapping.terminal,
    statusReason: mapping.statusReason,
    chainStatus: mapping.chainStatus,
    source: 'chain',
    stale,
    ageSeconds,
    observedAt: observation.observedAt,
    ledger: observation.ledger,
  };
}

/**
 * Assert that `reported` is exactly what the given chain state derives to.
 *
 * Used to catch a report that disagrees with the chain — the failure mode this
 * module exists to prevent — and returns the derived status so callers can log
 * both sides of the disagreement.
 */
export function assertReportedStatusMatchesChain(
  reported: ReportedStreamStatus,
  observation: ChainStateObservation,
): { ok: true; derived: DerivedStreamStatus } | { ok: false; message: string; derived: DerivedStreamStatus } {
  const derived = deriveStreamStatus(observation);

  if (reported === derived.status) return { ok: true, derived };

  const because = derived.chainStatus === null
    ? `chain status ${JSON.stringify(observation.chainStatus)} cannot be interpreted, so the only honest report is 'unknown'`
    : `chain status '${derived.chainStatus}' derives to '${derived.status}'`;

  return {
    ok: false,
    derived,
    message: `Reported status '${reported}' does not match the chain state: ${because}`,
  };
}

export interface StreamScheduleInput {
  startTime: number;
  endTime: number;
  status: ApiStreamStatus;
  now?: number;
}

const SCHEDULE_PRECEDENCE: Record<ApiStreamStatus, number> = {
  cancelled: 0,
  completed: 0,
  paused: 1,
  active: 2,
};

export interface DerivedScheduleStatus {
  status: ApiStreamStatus;
  terminal: boolean;
  source: 'schedule';
}

export function deriveStreamStatusFromSchedule(
  input: StreamScheduleInput,
): DerivedScheduleStatus {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const persisted = isApiStreamStatus(input.status) ? input.status : 'active';
  const cliffCrossed = input.startTime <= now;
  const indefinite = input.endTime === 0;
  const matured = !indefinite && input.endTime <= now;

  if (SCHEDULE_PRECEDENCE[persisted] < SCHEDULE_PRECEDENCE.active) {
    return { status: persisted, terminal: isTerminalStatus(persisted), source: 'schedule' };
  }

  if (!cliffCrossed) {
    return { status: 'active', terminal: false, source: 'schedule' };
  }

  if (matured) {
    return { status: 'completed', terminal: true, source: 'schedule' };
  }
  return { status: 'active', terminal: false, source: 'schedule' };
}

