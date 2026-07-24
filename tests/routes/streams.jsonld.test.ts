import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock the repository before importing the app ──────────────────────────────
const mockGetById = vi.fn();

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: (...a: unknown[]) => mockGetById(...a),
  },
}));

import { createApp } from '../../src/app.js';
import { initializeConfig } from '../../src/config/env.js';

// Initialize config before importing anything that needs it
initializeConfig();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_SENDER    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

const app = createApp();

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDbRecord(overrides: Record<string, unknown> = {}) {
  return {
    id:                'stream-abc123-0',
    sender_address:    VALID_SENDER,
    recipient_address: VALID_RECIPIENT,
    amount:            '1000',
    streamed_amount:   '0',
    remaining_amount:  '1000',
    rate_per_second:   '10',
    start_time:        1700000000,
    end_time:          0,
    status:            'active',
    contract_id:       'api-created',
    transaction_hash:  'a'.repeat(64),
    event_index:       0,
    created_at:        '2024-01-01T00:00:00.000Z',
    updated_at:        '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/streams/:id/export.jsonld', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 if stream does not exist', async () => {
    const res = await request(app).get('/api/streams/non-existent/export.jsonld');
    expect(res.status).toBe(404);
  });

  it('returns JSON-LD representation of the stream', async () => {
    const dbRecord = makeDbRecord();
    mockGetById.mockResolvedValue(dbRecord);

    const res = await request(app).get(`/api/streams/${dbRecord.id}/export.jsonld`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/ld\+json/);
    
    // We expect the JSON body to be exactly what we mapped
    const body = res.body;
    expect(body['@context']).toBe('https://fluxora.dev/ns/v1');
    expect(body['@type']).toBe('PaymentStream');
    expect(body.identifier).toBe(dbRecord.id);
    expect(body.sender).toBe(dbRecord.sender_address);
    expect(body.recipient).toBe(dbRecord.recipient_address);
    expect(body.depositAmount).toBe(dbRecord.amount);
    expect(body.streamedAmount).toBe(dbRecord.streamed_amount);
    expect(body.remainingAmount).toBe(dbRecord.remaining_amount);
    expect(body.ratePerSecond).toBe(dbRecord.rate_per_second);
    expect(body.startTime).toBe(dbRecord.start_time);
    expect(body.endTime).toBe(dbRecord.end_time);
    expect(body.status).toBe(dbRecord.status);
  });

  it('preserves decimal strings precisely', async () => {
    const dbRecord = makeDbRecord({
      amount: '123456789.1234567',
      rate_per_second: '0.0000001'
    });
    mockGetById.mockResolvedValue(dbRecord);

    const res = await request(app).get(`/api/streams/${dbRecord.id}/export.jsonld`);

    expect(res.status).toBe(200);
    expect(res.body.depositAmount).toBe('123456789.1234567');
    expect(res.body.ratePerSecond).toBe('0.0000001');
  });
});
