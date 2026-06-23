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
