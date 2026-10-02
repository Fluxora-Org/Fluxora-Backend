import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import {
  ReplayProgressSchema,
  ContractEventSchema,
  ReplayProgress,
} from '../../src/types/index.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';
import { setIndexerIngestAuthToken, resetIndexerState } from '../../src/routes/indexer.js';

const INDEXER_TOKEN = 'test-indexer-token';
let adminToken: string;

beforeAll(() => {
  initializeConfig();
  adminToken = generateToken({
    address: 'GADMIN',
    role: 'admin',
    permissions: ['indexer:replay'],
  });
});

beforeEach(() => {
  resetIndexerState();
  setIndexerIngestAuthToken(INDEXER_TOKEN);
});

describe('Handler Type Contract Enforcement (#1573)', () => {
  it('GET /internal/indexer/status returns a response that strictly satisfies ReplayProgressSchema', async () => {
    const res = await request(app)
      .get('/internal/indexer/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();

    // Parse data against shared Zod schema from src/types/index.ts
    const parseResult = ReplayProgressSchema.safeParse(res.body.data);
    expect(parseResult.success, `Response data failed ReplayProgressSchema validation: ${JSON.stringify(parseResult.success ? null : parseResult.error)}`).toBe(true);

    const progress: ReplayProgress = res.body.data;
    expect(typeof progress.isReplaying).toBe('boolean');
    expect(typeof progress.rowsReplayed).toBe('number');
    expect(typeof progress.rowsRemaining).toBe('number');
    expect(typeof progress.totalRows).toBe('number');
  });

  it('POST /internal/indexer/events/replay status property strictly satisfies ReplayProgressSchema', async () => {
    const res = await request(app)
      .post('/internal/indexer/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        contract_id: 'CCONTRACT123',
        ledger: 512345,
      })
      .expect(202);

    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toBe('Replay started');
    expect(res.body.data.status).toBeDefined();

    const parseResult = ReplayProgressSchema.safeParse(res.body.data.status);
    expect(parseResult.success, `Response status failed ReplayProgressSchema validation: ${JSON.stringify(parseResult.success ? null : parseResult.error)}`).toBe(true);

    const status: ReplayProgress = res.body.data.status;
    expect(typeof status.isReplaying).toBe('boolean');
  });

  it('ContractEventSchema validates an ingested event structure', () => {
    const mockEvent = {
      event_id: 'evt-001',
      contract_id: 'C123',
      ledger: 5000,
      event_type: 'stream.created',
      event_data: { streamId: 's1' },
      block_height: 5000,
      transaction_hash: 'txhash123',
    };

    const parseResult = ContractEventSchema.safeParse(mockEvent);
    expect(parseResult.success).toBe(true);
  });
});
