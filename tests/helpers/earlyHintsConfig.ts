import { vi } from 'vitest';
import { getConfig, type Config } from '../../src/config/env.js';

/**
 * Shared config-mock helper for Early Hints unit tests.
 *
 * Ensures `getConfig()` returns `{ earlyHintsEnabled: true }` (plus any
 * test-specific overrides) when called by `isEarlyHintsConfigEnabled()`,
 * `sendEarlyHints()`, and `sendEarlyHintsWithBoth()`.
 */
export function mockEarlyHintsConfig(
  overrides: { earlyHintsEnabled?: boolean } = {},
): void {
  const mockedGetConfig = vi.mocked(getConfig);
  mockedGetConfig.mockReturnValue({
    earlyHintsEnabled: true,
    ...overrides,
  } as unknown as Config);
}
