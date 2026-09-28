import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseFlagsJson,
  isEnabled,
  getRolloutBucket,
  fnv1a32,
  prepareReloadFlags,
  reloadFlags,
  getFlags,
  checkSchemaCompatibility,
  FeatureFlagDefinition
} from './featureFlags.js';

describe('featureFlags', () => {
  beforeEach(() => {
    vi.stubEnv('FEATURE_FLAGS_JSON', '');
    vi.stubEnv('FEATURE_FLAGS_FILE', '');
    reloadFlags();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('parseFlagsJson', () => {
    it('should parse valid flags with default, owner, and removalDate', () => {
      const json = JSON.stringify([
        {
          name: 'test_flag',
          percentage: 100,
          default: false,
          owner: 'test_owner',
          removalDate: '2099-12-31'
        }
      ]);
      const flags = parseFlagsJson(json);
      expect(flags.has('test_flag')).toBe(true);
      const flag = flags.get('test_flag');
      expect(flag?.default).toBe(false);
      expect(flag?.owner).toBe('test_owner');
      expect(flag?.removalDate).toBe('2099-12-31');
    });

    it('should fail a check if flag is past its removal date', () => {
      const json = JSON.stringify([
        {
          name: 'expired_flag',
          percentage: 100,
          default: false,
          owner: 'test_owner',
          removalDate: '2020-01-01'
        }
      ]);
      expect(() => parseFlagsJson(json)).toThrowError(/past its removal date/);
    });

    it('should throw an error if missing owner', () => {
      const json = JSON.stringify([
        {
          name: 'no_owner',
          percentage: 100,
          default: false,
          removalDate: '2099-12-31'
        }
      ]);
      expect(() => parseFlagsJson(json)).toThrowError(/missing an owner/);
    });

    it('should throw an error if missing default', () => {
      const json = JSON.stringify([
        {
          name: 'no_default',
          percentage: 100,
          owner: 'owner',
          removalDate: '2099-12-31'
        }
      ]);
      expect(() => parseFlagsJson(json)).toThrowError(/missing a default/);
    });
  });

  describe('isEnabled', () => {
    it('covers both states of a flag affecting behaviour', () => {
      const json = JSON.stringify([
        {
          name: 'behaviour_flag',
          percentage: 0,
          default: false,
          owner: 'test',
          removalDate: '2099-01-01'
        }
      ]);
      vi.stubEnv('FEATURE_FLAGS_JSON', json);
      reloadFlags();
      
      // State 1: Flag is disabled (0%)
      expect(isEnabled('behaviour_flag', 'user1')).toBe(false);

      // State 2: Flag is enabled (100%)
      const json2 = JSON.stringify([
        {
          name: 'behaviour_flag',
          percentage: 100,
          default: false,
          owner: 'test',
          removalDate: '2099-01-01'
        }
      ]);
      vi.stubEnv('FEATURE_FLAGS_JSON', json2);
      reloadFlags();
      expect(isEnabled('behaviour_flag', 'user1')).toBe(true);
    });
  });
});
