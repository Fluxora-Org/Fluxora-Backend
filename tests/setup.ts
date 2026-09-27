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
 *
 * The readiness phase is also forced to READY. `app.ts` mounts
 * `readinessGuardMiddleware()` at the root, which answers 503 for every
 * request until the real startup sequence completes. Route tests import `app`
 * directly and never run that sequence, so without this every supertest
 * assertion sees 503 instead of the handler under test. `_setPhase` is used
 * rather than `markReady()` because it skips the "unexpected transition"
 * warning that the ordered startup sequence exists to raise. Suites that
 * assert startup/readiness behaviour reset the phase themselves
 * (`_resetReadinessState` / `_setPhase` in `tests/startup-readiness.test.ts`).
 */

import './env-defaults.js';
import { initializeConfig } from '../src/config/env.js';
import { _setPhase } from '../src/startup/readiness.js';

initializeConfig();
_setPhase('READY');
