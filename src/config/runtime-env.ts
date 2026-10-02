/**
 * Compatibility access for settings that are not yet represented as typed
 * properties on Config.
 *
 * Importers must use this module instead of touching process.env directly.
 * Importing the validated env module first preserves the fail-fast startup
 * check for the canonical schema while this compatibility surface is reduced
 * over time.
 */
import './env.js';

export function getRuntimeEnv(): NodeJS.ProcessEnv {
  return process.env;
}
