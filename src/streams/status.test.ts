import { describe, it, expect } from 'vitest';
import {
  API_STREAM_STATUSES,
  DEFAULT_MAX_STALENESS_SECONDS,
  assertReportedStatusMatchesChain,
  defaultChainStatusForStartTime,
  deriveStreamStatus,
  deriveStreamStatusFromSchedule,
  isReportedStreamStatus,
  isValidApiTransition,
  mapChainStatusToApiStatus,
  type ApiStreamStatus,
  type ChainStateObservation,
  type ChainStreamStatus,
  type StreamScheduleInput,
} from './status.js';

describe('mapChainStatusToApiStatus', () => {
  it('maps pending to active non-terminal', () => {
    expect(mapChainStatusToApiStatus('pending')).toEqual({
      chainStatus: 'pending',
      status: 'active',
      terminal: false,
    });
  });

  it('maps depleted to completed terminal with reason', () => {
    expect(mapChainStatusToApiStatus('depleted')).toEqual({
      chainStatus: 'depleted',
      status: 'completed',
      terminal: true,
      statusReason: 'depleted',
    });
  });
});

describe('defaultChainStatusForStartTime', () => {
  it('returns pending for future start time', () => {
    expect(defaultChainStatusForStartTime(2_000_000_000, 1_900_000_000)).toBe('pending');
  });

  it('returns active for past start time', () => {
    expect(defaultChainStatusForStartTime(1_800_000_000, 1_900_000_000)).toBe('active');
  });
});

// --- fixtures ---------------------------------------------------------------
//
// One fixture per chain state. `deriveStreamStatus` must reproduce exactly
// what the chain says, so these are the contract the reported status is
// asserted against.

const NOW = 1_900_000_000;

const CHAIN_STATE_FIXTURES: Array<{
  chainStatus: ChainStreamStatus;
  status: ApiStreamStatus;
  terminal: boolean;
  statusReason?: 'depleted';
}> = [
  { chainStatus: 'pending', status: 'active', terminal: false },
  { chainStatus: 'active', status: 'active', terminal: false },
  { chainStatus: 'paused', status: 'paused', terminal: false },
  { chainStatus: 'completed', status: 'completed', terminal: true },
  { chainStatus: 'cancelled', status: 'cancelled', terminal: true },
  { chainStatus: 'depleted', status: 'completed', terminal: true, statusReason: 'depleted' },
];

const fixture = (overrides: Partial<ChainStateObservation> = {}): ChainStateObservation => ({
  chainStatus: 'active',
  observedAt: NOW - 10,
  ledger: 4_242,
  now: NOW,
  ...overrides,
});

describe('deriveStreamStatus', () => {
  it('covers every chain status in the fixtures', () => {
    expect(CHAIN_STATE_FIXTURES.map((f) => f.chainStatus).sort()).toEqual(
      [
        'active',
        'cancelled',
        'completed',
        'depleted',
        'paused',
        'pending',
      ].sort(),
    );
  });

  it.each(CHAIN_STATE_FIXTURES)(
    'derives $status (terminal: $terminal) from chain state $chainStatus',
    ({ chainStatus, status, terminal, statusReason }) => {
      const derived = deriveStreamStatus(fixture({ chainStatus }));

      expect(derived).toEqual({
        status,
        terminal,
        statusReason,
        chainStatus,
        source: 'chain',
        stale: false,
        ageSeconds: 10,
        observedAt: NOW - 10,
        ledger: 4_242,
      });
    },
  );

  it('derives the same status the mapping table defines (single source)', () => {
    for (const chainStatus of CHAIN_STATE_FIXTURES.map((f) => f.chainStatus)) {
      const mapping = mapChainStatusToApiStatus(chainStatus);
      const derived = deriveStreamStatus(fixture({ chainStatus }));

      expect(derived.status).toBe(mapping.status);
      expect(derived.terminal).toBe(mapping.terminal);
      expect(derived.statusReason).toBe(mapping.statusReason);
    }
  });

  it('never reports an API status the API does not define', () => {
    for (const { chainStatus } of CHAIN_STATE_FIXTURES) {
      const { status } = deriveStreamStatus(fixture({ chainStatus }));
      expect(API_STREAM_STATUSES).toContain(status);
    }
  });

  describe('when the chain state cannot be interpreted', () => {
    it.each([
      ['a status this build does not know', 'matured'],
      ['a differently cased value', 'ACTIVE'],
      ['an empty string', ''],
      ['null', null],
      ['a number', 42],
      ['an object', { status: 'active' }],
      ['undefined', undefined],
    ])('reports unknown for %s', (_label, chainStatus) => {
      const derived = deriveStreamStatus(fixture({ chainStatus }));

      expect(derived.status).toBe('unknown');
      expect(derived.chainStatus).toBeNull();
      expect(derived.terminal).toBe(false);
      expect(derived.statusReason).toBeUndefined();
      expect(derived.source).toBe('chain');
    });

    it('does not guess a non-terminal active status', () => {
      // A naive implementation coerces anything unknown to 'active', which is
      // how users end up seeing a live stream that no longer exists.
      expect(deriveStreamStatus(fixture({ chainStatus: 'matured' })).status).not.toBe('active');
    });
  });

  describe('staleness', () => {
    it('is false while the observation is fresh', () => {
      const derived = deriveStreamStatus(fixture({ observedAt: NOW - 1, chainStatus: 'paused' }));
      expect(derived.stale).toBe(false);
      expect(derived.ageSeconds).toBe(1);
    });

    it('is false exactly at the threshold and true just past it', () => {
      const atThreshold = deriveStreamStatus(
        fixture({ observedAt: NOW - DEFAULT_MAX_STALENESS_SECONDS }),
      );
      const pastThreshold = deriveStreamStatus(
        fixture({ observedAt: NOW - DEFAULT_MAX_STALENESS_SECONDS - 1 }),
      );

      expect(atThreshold.stale).toBe(false);
      expect(pastThreshold.stale).toBe(true);
    });

    it('honours a caller-supplied threshold', () => {
      const derived = deriveStreamStatus(
        fixture({ observedAt: NOW - 30, maxStalenessSeconds: 10 }),
      );
      expect(derived.stale).toBe(true);
      expect(derived.ageSeconds).toBe(30);
    });

    it('still surfaces staleness for an uninterpretable chain state', () => {
      const derived = deriveStreamStatus(
        fixture({ chainStatus: 'matured', observedAt: NOW - 3_600 }),
      );
      expect(derived.status).toBe('unknown');
      expect(derived.stale).toBe(true);
      expect(derived.ageSeconds).toBe(3_600);
    });

    it('clamps a future observation to zero age instead of going negative', () => {
      const derived = deriveStreamStatus(fixture({ observedAt: NOW + 60 }));
      expect(derived.ageSeconds).toBe(0);
      expect(derived.stale).toBe(false);
    });
  });

  it('omits the ledger when the caller did not supply one', () => {
    expect(deriveStreamStatus(fixture({ ledger: undefined })).ledger).toBeUndefined();
  });
});

describe('isReportedStreamStatus', () => {
  it('accepts every API status plus unknown', () => {
    for (const status of [...API_STREAM_STATUSES, 'unknown']) {
      expect(isReportedStreamStatus(status)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isReportedStreamStatus('matured')).toBe(false);
    expect(isReportedStreamStatus('')).toBe(false);
    expect(isReportedStreamStatus(null)).toBe(false);
  });
});

describe('assertReportedStatusMatchesChain', () => {
  it.each(CHAIN_STATE_FIXTURES)(
    'passes when $chainStatus is reported as $status',
    ({ chainStatus, status }) => {
      const result = assertReportedStatusMatchesChain(status, fixture({ chainStatus }));
      expect(result.ok).toBe(true);
      expect(result.derived.chainStatus).toBe(chainStatus);
    },
  );

  it('fails with the derived status when the report disagrees with the chain', () => {
    const result = assertReportedStatusMatchesChain('active', fixture({ chainStatus: 'paused' }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the assertion to fail');
    expect(result.message).toContain("Reported status 'active'");
    expect(result.message).toContain("chain status 'paused' derives to 'paused'");
    expect(result.derived.status).toBe('paused');
  });

  it("requires 'unknown' when the chain state cannot be interpreted", () => {
    const wrong = assertReportedStatusMatchesChain('active', fixture({ chainStatus: 'matured' }));
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error('expected the assertion to fail');
    expect(wrong.message).toContain("the only honest report is 'unknown'");

    const right = assertReportedStatusMatchesChain('unknown', fixture({ chainStatus: 'matured' }));
    expect(right.ok).toBe(true);
  });
});

describe('deriveStreamStatusFromSchedule', () => {
  const START = 1_700_000_000;
  const END = START + 1_000;
  const schedule = (overrides: Partial<StreamScheduleInput> = {}): StreamScheduleInput => ({
    startTime: START,
    endTime: END,
    status: 'active',
    now: START + 500,
    ...overrides,
  });

  it('reports active before the cliff and exactly at the cliff', () => {
    expect(deriveStreamStatusFromSchedule(schedule({ now: START - 1 })).status).toBe('active');
    expect(deriveStreamStatusFromSchedule(schedule({ now: START })).status).toBe('active');
  });

  it('reports active between cliff and maturity and exactly before maturity', () => {
    expect(deriveStreamStatusFromSchedule(schedule({ now: START + 1 })).status).toBe('active');
    expect(deriveStreamStatusFromSchedule(schedule({ now: END - 1 })).status).toBe('active');
  });

  it('reports completed exactly at maturity and after it', () => {
    expect(deriveStreamStatusFromSchedule(schedule({ now: END })).status).toBe('completed');
    expect(deriveStreamStatusFromSchedule(schedule({ now: END + 1 })).status).toBe('completed');
  });

  it('keeps an indefinite stream (endTime 0) active past the cliff', () => {
    expect(deriveStreamStatusFromSchedule(schedule({ endTime: 0, now: END + 5_000 })).status).toBe(
      'active',
    );
  });

  it('lets paused take precedence over the clock at cliff and maturity', () => {
    expect(deriveStreamStatusFromSchedule(schedule({ status: 'paused', now: START - 1 })).status).toBe(
      'paused',
    );
    expect(deriveStreamStatusFromSchedule(schedule({ status: 'paused', now: END })).status).toBe(
      'paused',
    );
    expect(deriveStreamStatusFromSchedule(schedule({ status: 'paused', now: END + 1 })).status).toBe(
      'paused',
    );
  });

  it('lets completed and cancelled beat the clock at every boundary', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(deriveStreamStatusFromSchedule(schedule({ status, now: START - 1 })).status).toBe(status);
      expect(deriveStreamStatusFromSchedule(schedule({ status, now: END })).status).toBe(status);
    }
  });

  it('marks the derived status terminal only for completed and cancelled', () => {
    expect(deriveStreamStatusFromSchedule(schedule()).terminal).toBe(false);
    expect(deriveStreamStatusFromSchedule(schedule({ status: 'paused' })).terminal).toBe(false);
    expect(deriveStreamStatusFromSchedule(schedule({ now: END })).terminal).toBe(true);
    expect(deriveStreamStatusFromSchedule(schedule({ status: 'cancelled' })).terminal).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const a = deriveStreamStatusFromSchedule(schedule({ now: END - 1 }));
    const b = deriveStreamStatusFromSchedule(schedule({ now: END - 1 }));
    expect(a).toEqual(b);
  });

  it('agrees with the transition state machine at every boundary', () => {
    const cases: Array<[StreamScheduleInput, ApiStreamStatus]> = [
      [schedule({ now: START - 1 }), 'active'],
      [schedule({ now: START }), 'active'],
      [schedule({ now: END - 1 }), 'active'],
      [schedule({ now: END }), 'completed'],
      [schedule({ status: 'paused', now: END }), 'paused'],
      [schedule({ status: 'paused', now: START - 1 }), 'paused'],
      [schedule({ status: 'completed', now: START - 1 }), 'completed'],
      [schedule({ status: 'cancelled', now: END }), 'cancelled'],
    ];

    for (const [input, expected] of cases) {
      const derived = deriveStreamStatusFromSchedule(input).status;
      expect(derived).toBe(expected);
      expect(isValidApiTransition(derived, derived)).toBe(false);
    }
  });

  it('agrees with defaultChainStatusForStartTime across the start boundary', () => {
    for (const now of [START - 1, START, START + 1]) {
      const chain = defaultChainStatusForStartTime(START, now);
      const derived = deriveStreamStatusFromSchedule(schedule({ now })).status;
      expect(derived).toBe(chain === 'pending' ? 'active' : chain);
    }
  });
});

describe('single source of status (consumer agreement)', () => {
  it('exposes one shared API status list that every boundary case belongs to', () => {
    const START = 1_700_000_000;
    const END = START + 1_000;
    const statuses = new Set<ApiStreamStatus>();
    for (const now of [START - 1, START, END - 1, END, END + 1]) {
      statuses.add(
        deriveStreamStatusFromSchedule({ startTime: START, endTime: END, status: 'active', now })
          .status,
      );
    }
    statuses.add(
      deriveStreamStatusFromSchedule({ startTime: START, endTime: END, status: 'paused', now: END })
        .status,
    );
    statuses.add(
      deriveStreamStatusFromSchedule({
        startTime: START,
        endTime: END,
        status: 'cancelled',
        now: START,
      }).status,
    );

    for (const status of statuses) {
      expect(API_STREAM_STATUSES).toContain(status);
    }
  });

  it('shares the transition table with the DB invariants', async () => {
    const { STREAM_INVARIANTS } = await import('../db/types.js');
    const { VALID_API_TRANSITIONS } = await import('./status.js');
    expect(STREAM_INVARIANTS.validTransitions).toBe(VALID_API_TRANSITIONS);
  });

  it('shares the status list with the pagination schema', async () => {
    const { STREAM_STATUS_VALUES } = await import('../validation/paginationSchema.js');
    expect(STREAM_STATUS_VALUES).toBe(API_STREAM_STATUSES);
  });
});
