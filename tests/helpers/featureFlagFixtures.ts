import type { FeatureFlagDefinition } from '../../src/config/featureFlags.js';

export const DEFAULT_FLAG_FIXTURE: Omit<FeatureFlagDefinition, 'name'> = {
  percentage: 100,
  default: false,
  owner: 'test',
  removalDate: '2099-01-01',
};

/**
 * Build a valid FeatureFlagDefinition fixture with required metadata defaults
 * (`owner`, `default`, `removalDate`) so tests remain resilient to schema
 * additions while keeping validation strict.
 */
export function flag(
  name: string,
  overrides: Partial<Omit<FeatureFlagDefinition, 'name'>> = {},
): FeatureFlagDefinition {
  return {
    name,
    ...DEFAULT_FLAG_FIXTURE,
    ...overrides,
  };
}
