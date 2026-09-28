import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isEnabled, reloadFlags } from '../../src/config/featureFlags.js';
import { GRAPHQL_GATEWAY_FLAG } from '../../src/graphql/gateway.js';
import { STREAMS_ENHANCED_RESPONSE_FLAG } from '../../src/routes/streams.js';

// Central record of all active feature flags in the service.
const ACTIVE_FLAGS = [
  {
    name: GRAPHQL_GATEWAY_FLAG,
    default: false,
    owner: 'team-api',
    removalDate: '2026-12-31'
  },
  {
    name: STREAMS_ENHANCED_RESPONSE_FLAG,
    default: false,
    owner: 'team-data',
    removalDate: '2026-12-31'
  }
];

describe('Active Feature Flags', () => {
  beforeEach(() => {
    vi.stubEnv('FEATURE_FLAGS_JSON', '');
    vi.stubEnv('FEATURE_FLAGS_FILE', '');
    reloadFlags();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('every flag has a documented default, owner, and removal condition', () => {
    ACTIVE_FLAGS.forEach(flag => {
      expect(flag.name).toBeTruthy();
      expect(flag.default).toBeDefined();
      expect(flag.owner).toBeTruthy();
      expect(flag.removalDate).toBeTruthy();
    });
  });

  it('a flag past its removal date fails a check', () => {
    ACTIVE_FLAGS.forEach(flag => {
      const removalTime = new Date(flag.removalDate).getTime();
      expect(Date.now()).toBeLessThanOrEqual(removalTime);
    });
  });

  describe('Tests cover both states of each flag affecting behaviour', () => {
    ACTIVE_FLAGS.forEach(flag => {
      it(`tests both states for ${flag.name}`, () => {
        // Test state 1: Flag disabled
        process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([{ ...flag, percentage: 0 }]);
        reloadFlags();
        expect(isEnabled(flag.name, 'requester-1')).toBe(false);

        // Test state 2: Flag enabled
        process.env['FEATURE_FLAGS_JSON'] = JSON.stringify([{ ...flag, percentage: 100 }]);
        reloadFlags();
        expect(isEnabled(flag.name, 'requester-1')).toBe(true);
      });
    });
  });
});
