/**
 * Vitest global setup.
 *
 * Runs once before any test file is imported.
 *
 * Import order matters and is load-bearing: `./env-defaults.js` populates
 * `process.env` and MUST be evaluated before `../src/config/env.js`, which
 * parses `process.env` at its own module load. ES module imports are evaluated
 * in source order, so listing env-defaults first is what guarantees it — this
 * previously relied on a top-level `await import(...)`, which the CommonJS
 * build target rejects.
 */

import './env-defaults.js';
import { initializeConfig } from '../src/config/env.js';

initializeConfig();
