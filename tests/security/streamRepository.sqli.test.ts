import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliPayloads } from './fixtures/sqliPayloads.js';

const mockQuery = vi.fn();

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(detail?: string) {
      super(detail ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
}));

vi.mock('../../src/db/replicaPool.js', () => ({
  getReadPool: vi.fn(async () => ({})),
}));

import { initializeConfig, resetConfig } from '../../src/config/env.js';
import { streamRepository } from '../../src/db/repositories/streamRepository.js';

const PGCRYPTO_KEY = 'stream-repository-sqli-test-key-12345';
const ROW = {
  id: 'stream-sqli-0',
  sender_address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
  recipient_address: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
  amount: '1000',
  streamed_amount: '0',
  remaining_amount: '1000',
  rate_per_second: '10',
  start_time: '1700000000',
  end_time: '0',
  status: 'active',
  contract_id: 'api-created',
  transaction_hash: 'a'.repeat(64),
  event_index: 0,
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
};

function assertPayloadIsParameterized(payload: string): void {
  const calls = mockQuery.mock.calls as Array<[unknown, string, unknown[] | undefined]>;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.some(([, , params]) => Array.isArray(params) && params.includes(payload))).toBe(true);
  for (const [, sql] of calls) {
    expect(sql).not.toContain(payload);
  }
}

describe('streamRepository SQLi regression suite', () => {
  beforeEach(() => {
    process.env.PGCRYPTO_KEY = PGCRYPTO_KEY;
    resetConfig();
    initializeConfig();
    mockQuery.mockReset();
  });

  for (const payload of sqliPayloads) {
    it(`keeps getById payload parameterized [${payload}]`, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(streamRepository.getById(payload)).resolves.toBeUndefined();

      assertPayloadIsParameterized(payload);
    });

    it(`keeps findWithCursor contract filter parameterized [${payload}]`, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [ROW] });

      await expect(streamRepository.findWithCursor({ contract_id: payload }, 1)).resolves.toBeDefined();

      assertPayloadIsParameterized(payload);
    });

    it(`keeps updateStream id parameterized [${payload}]`, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [ROW] });
      mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'paused' }] });

      await expect(streamRepository.updateStream(payload, { status: 'paused' })).resolves.toBeDefined();

      assertPayloadIsParameterized(payload);
    });
  }
});
