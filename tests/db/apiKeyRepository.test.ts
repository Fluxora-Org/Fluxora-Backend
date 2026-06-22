import { describe, it, expect, vi, afterEach } from 'vitest';
import type pg from 'pg';
import { apiKeyRepository } from '../../src/db/repositories/apiKeyRepository.js';
import { setPool } from '../../src/db/pool.js';

function makePool(rows: Record<string, unknown>[] = []): pg.Pool {
  return {
    waitingCount: 0,
    totalCount: 0,
    idleCount: 0,
    query: vi.fn().mockResolvedValue({
      rows,
      rowCount: rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    }),
  } as unknown as pg.Pool;
}

describe('apiKeyRepository', () => {
  afterEach(() => {
    setPool(null);
  });

  it('looks up active keys by indexed lookup_hash rather than scanning all rows', async () => {
    const pool = makePool([]);
    setPool(pool);

    await apiKeyRepository.findActiveByLookupHash('a'.repeat(64));

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('WHERE lookup_hash = $1 AND revoked_at IS NULL');
    expect(sql).not.toMatch(/SELECT \*/);
    expect(params).toEqual(['a'.repeat(64)]);
  });

  it('omits key_salt and lookup_hash from public list records', async () => {
    const pool = makePool([
      {
        id: 'key-1',
        name: 'service-a',
        key_hash: 'b'.repeat(64),
        key_salt: 'c'.repeat(32),
        lookup_hash: 'd'.repeat(64),
        prefix: 'flx_abcd',
        created_at: new Date('2026-06-22T00:00:00.000Z'),
        rotated_at: null,
        revoked_at: null,
      },
    ]);
    setPool(pool);

    const records = await apiKeyRepository.list();

    expect(records).toEqual([
      {
        id: 'key-1',
        name: 'service-a',
        keyHash: 'b'.repeat(64),
        prefix: 'flx_abcd',
        createdAt: '2026-06-22T00:00:00.000Z',
        rotatedAt: null,
        revokedAt: null,
        active: true,
      },
    ]);
    expect(records[0]).not.toHaveProperty('keySalt');
    expect(records[0]).not.toHaveProperty('lookupHash');
  });
});
