import { expect, test, describe } from 'vitest';
import { 
  composeConfiguration, 
  baseConfig, 
  envOverrideConfig, 
  featureFlagsConfig,
  COMPOSITION_ORDER
} from './index.js';

describe('Configuration Composition', () => {
  test('asserts documented precedence for overlapping settings', () => {
    // Both baseConfig and envOverrideConfig define 'port'
    // baseConfig sets it to 3000
    expect(baseConfig.port).toBe(3000);
    // envOverrideConfig sets it to 8080
    expect(envOverrideConfig.port).toBe(8080);
    
    // Both featureFlagsConfig and envOverrideConfig define 'overlappingSetting'
    expect(featureFlagsConfig.overlappingSetting).toBe('flag');
    expect(envOverrideConfig.overlappingSetting).toBe('envOverride');

    // According to COMPOSITION_ORDER, envOverrideConfig is placed AFTER baseConfig and featureFlagsConfig.
    // Thus, it should override earlier ones.
    const effectiveConfig = composeConfiguration(COMPOSITION_ORDER);
    
    // The later module (envOverrideConfig) wins precedence
    expect(effectiveConfig.port).toBe(8080);
    expect(effectiveConfig.overlappingSetting).toBe('envOverride');
  });

  test('effective configuration does not depend on import order, but explicit composition order', () => {
    const moduleA = { setting: 'A', uniqueA: true };
    const moduleB = { setting: 'B', uniqueB: true };
    
    // Explicitly defining B after A
    const configAB = composeConfiguration([moduleA, moduleB]);
    expect(configAB.setting).toBe('B');
    expect(configAB.uniqueA).toBe(true);
    expect(configAB.uniqueB).toBe(true);

    // Explicitly defining A after B
    const configBA = composeConfiguration([moduleB, moduleA]);
    expect(configBA.setting).toBe('A');
    expect(configBA.uniqueA).toBe(true);
    expect(configBA.uniqueB).toBe(true);
  });
});
