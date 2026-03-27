export const CHAIN_STREAM_STATUSES = [
  'pending',
  'active',
  'paused',
  'completed',
  'cancelled',
  'depleted',
] as const;

export const API_STREAM_STATUSES = [
  'scheduled',
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
    status: 'scheduled',
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
