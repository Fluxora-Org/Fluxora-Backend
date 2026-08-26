/**
 * Test environment defaults.
 *
 * Split out of `setup.ts` so the ordering requirement is expressed by ES module
 * import hoisting rather than a dynamic import. `src/config/env.ts` parses
 * `process.env` at module load, so every value it needs must already be set
 * before that module is first evaluated. Importing this file *before*
 * `../src/config/env.js` in `setup.ts` guarantees exactly that, because ES
 * imports are evaluated in source order.
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
