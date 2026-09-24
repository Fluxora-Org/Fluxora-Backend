/**
 * Keeps `docs/connection-limits.md` honest.
 *
 * The document is the single place where the connection and statement limits of
 * every external dependency are collected. These tests parse its limit table and
 * assert that it agrees with the configuration schema (`EnvSchema`) and with the
 * registry in `./connectionLimits.ts`, so a limit cannot be added, renumbered or
 * re-defaulted in code without updating the document.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { EnvSchema } from './env.js';
import {
  CONNECTION_LIMIT_DEFAULTS,
  CONNECTION_LIMITS,
  worstCaseDatabaseConnections,
  type ConnectionLimitKey,
} from './connectionLimits.js';

const doc = readFileSync(new URL('../../docs/connection-limits.md', import.meta.url), 'utf8');

/**
 * The minimum environment `EnvSchema` needs to parse. Every other value is left
 * to its `.default(...)`, which is exactly what these tests read.
 */
const MINIMAL_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/fluxora_test',
  JWT_SECRET: 'a-very-long-secret-key-for-testing-only-12345',
  INDEXER_WORKER_TOKEN: 'indexer-worker-token-for-testing-only-12345',
  STELLAR_CONTRACT_ADDRESS: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
  STELLAR_TOKEN_ADDRESS: 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6',
};

const schemaDefaults = EnvSchema.parse(MINIMAL_ENV) as unknown as Record<string, unknown>;

/** A `| \`ENV_VAR\` | ... | \`default\` | ... |` row from the document's limit table. */
const LIMIT_ROW = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*`([^`]+)`\s*\|/;

/**
 * Extract the document's limit rows as a map of environment variable to the
 * documented default. Rows whose default is not a bare integer map to `null`.
 * Duplicate variables are recorded with a count so the tests can reject them.
 */
function parseDocumentedLimits(markdown: string): Map<string, { value: number | null; count: number }> {
  const documented = new Map<string, { value: number | null; count: number }>();
  for (const rawLine of markdown.split('\n')) {
    const match = LIMIT_ROW.exec(rawLine.trim());
    if (!match) continue;
    const [, envVar, rawValue] = match;
    const parsed = Number.parseInt(rawValue, 10);
    const previous = documented.get(envVar);
    documented.set(envVar, {
      value: Number.isFinite(parsed) ? parsed : null,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return documented;
}

const documented = parseDocumentedLimits(doc);

describe('docs/connection-limits.md', () => {
  test('documents every declared limit exactly once', () => {
    const keys = Object.keys(CONNECTION_LIMIT_DEFAULTS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(documented.has(key), `no documentation row for ${key}`).toBe(true);
      expect(documented.get(key)?.count, `${key} is documented more than once`).toBe(1);
    }
  });

  test('documented defaults match the configuration schema', () => {
    for (const limit of CONNECTION_LIMITS) {
      const key = limit.envVar;
      const declared = CONNECTION_LIMIT_DEFAULTS[key];
      expect(
        schemaDefaults[key],
        `${key} must use CONNECTION_LIMIT_DEFAULTS as its schema default`,
      ).toBe(declared);
      expect(documented.get(key)?.value, `documented default for ${key} is stale`).toBe(declared);
    }
  });

  test('registry names only declared limits', () => {
    const keys = new Set(Object.keys(CONNECTION_LIMIT_DEFAULTS));
    for (const limit of CONNECTION_LIMITS) {
      expect(keys.has(limit.envVar), `${limit.envVar} is not in CONNECTION_LIMIT_DEFAULTS`).toBe(true);
    }
  });

  test('registry covers every declared limit', () => {
    const registered = new Set(CONNECTION_LIMITS.map((limit) => limit.envVar));
    for (const key of Object.keys(CONNECTION_LIMIT_DEFAULTS)) {
      expect(
        registered.has(key as ConnectionLimitKey),
        `${key} is missing from CONNECTION_LIMITS`,
      ).toBe(true);
    }
  });

  test('states the combined worst-case connection count', () => {
    const worstCase = worstCaseDatabaseConnections();
    expect(worstCase).toBe(CONNECTION_LIMIT_DEFAULTS.DB_POOL_MAX * 2);
    expect(doc).toContain(`Combined worst-case pooled database connections: ${worstCase}`);
  });
});
