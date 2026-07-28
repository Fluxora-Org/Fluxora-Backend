/**
 * Vitest global setup.
 *
 * Runs once before any test file is imported.  Sets the environment-driven
 * configuration that every test relies on:
 *
 * - `RATE_LIMIT_ENABLED=false` so route tests do not see 429s as side-effects
 *   of other tests in the same process.
 * - `NODE_ENV=test` and a deterministic `JWT_SECRET` so `generateToken()` /
 *   `verifyToken()` work without each test having to re-initialise config.
 * - Calls `initializeConfig()` so tests that reach into the live config
 *   object (e.g. via `getConfig()` in `streamRepository`) don't fail with
 *   "Configuration not initialized" when this file is run in isolation
 *   (single-file vitest execution, post-commit hooks, local debugging).
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED ?? 'false';
// Disable Redis in tests to prevent connection attempts to a non-existent server.
// Tests that need Redis semantics use FakeRedisClient or InMemoryIdempotencyStore directly.
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED ?? 'false';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://localhost/fluxora_test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'a-very-long-secret-key-for-testing-only-12345';
process.env.INDEXER_WORKER_TOKEN =
  process.env.INDEXER_WORKER_TOKEN ?? 'indexer-worker-token-for-testing-only-12345';
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER ?? 'api-key-pepper-for-testing-only-0123456789abcdef';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
process.env.STELLAR_CONTRACT_ADDRESS =
  process.env.STELLAR_CONTRACT_ADDRESS ?? 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';
process.env.STELLAR_TOKEN_ADDRESS =
  process.env.STELLAR_TOKEN_ADDRESS ?? 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6';
process.env.PGCRYPTO_KEY =
  process.env.PGCRYPTO_KEY ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Bootstrap the application config from the (now-set) environment.
//
// IMPORTANT: `src/config/env.ts` invokes `parseEnv(process.env)` at its own
// module load (env.ts:791), so the module must NOT be statically imported
// above — ES module `import` declarations are hoisted above top-level code
// and would load env.ts before the `process.env.* ??` defaults above were
// applied, causing Zod to throw "env required" errors for DATABASE_URL,
// JWT_SECRET, INDEXER_WORKER_TOKEN, STELLAR_CONTRACT_ADDRESS, and
// STELLAR_TOKEN_ADDRESS.
//
// We use a dynamic `await import(...)` so that env.ts is loaded *after* the
// synchronous env-var setters have run.  Vitest supports top-level await in
// setupFiles, so this file can stay declarative and side-effect-free above.
const { initializeConfig } = await import('../src/config/env.js');
initializeConfig();
