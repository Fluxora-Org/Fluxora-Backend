/**
 * tests/sweep.test.ts
 *
 * Covers the liability-based sweep invariant:
 *   sweepable = contractBalance - outstandingLiabilities
 *
 * Scenarios:
 *   1. Active stream — full depositAmount is a liability
 *   2. Cancelled stream with undrawn accrual — depositAmount still a liability
 *   3. Completed stream awaiting close — depositAmount still a liability
 *   4. No streams — entire balance is sweepable
 *   5. validateSweepRequest blocks over-sweep
 *   6. validateSweepRequest allows exact-sweepable amount
 *   7. POST /api/admin/sweep integration (auth + invariant)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { calculateSweepable, validateSweepRequest } from '../src/lib/sweep.js';
import type { Stream } from '../src/routes/streams.js';
import { streams } from '../src/routes/streams.js';
import app from '../src/app.js';

// ─── Unit: calculateSweepable ─────────────────────────────────────────────────

function makeStream(overrides: Partial<Stream> & { id: string; status: string }): Stream {
  return {
    sender: 'GABC',
    recipient: 'GXYZ',
    depositAmount: '100.0000000',
    ratePerSecond: '0.0000116',
    startTime: 1700000000,
    endTime: 0,
    ...overrides,
  } as Stream;
}

describe('calculateSweepable', () => {
  it('active stream — full depositAmount is a liability', () => {
    const result = calculateSweepable({
      contractBalance: '150.0000000',
      streams: [makeStream({ id: 's1', status: 'active', depositAmount: '100.0000000' })],
    });
    expect(result.totalLiabilities).toBe('100.0000000');
    expect(result.sweepableAmount).toBe('50.0000000');
  });

  it('paused stream — full depositAmount is a liability', () => {
    const result = calculateSweepable({
      contractBalance: '200.0000000',
      streams: [makeStream({ id: 's1', status: 'paused', depositAmount: '120.0000000' })],
    });
    expect(result.totalLiabilities).toBe('120.0000000');
    expect(result.sweepableAmount).toBe('80.0000000');
  });

  it('cancelled stream with undrawn accrual — depositAmount is a liability', () => {
    // Cancelled but recipient hasn't withdrawn yet; we conservatively treat
    // the full depositAmount as owed until settlement is confirmed.
    const result = calculateSweepable({
      contractBalance: '300.0000000',
      streams: [makeStream({ id: 's1', status: 'cancelled', depositAmount: '200.0000000' })],
    });
    expect(result.totalLiabilities).toBe('200.0000000');
    expect(result.sweepableAmount).toBe('100.0000000');
  });

  it('completed stream awaiting close — depositAmount is a liability', () => {
    const result = calculateSweepable({
      contractBalance: '500.0000000',
      streams: [makeStream({ id: 's1', status: 'completed', depositAmount: '400.0000000' })],
    });
    expect(result.totalLiabilities).toBe('400.0000000');
    expect(result.sweepableAmount).toBe('100.0000000');
  });

  it('no streams — entire balance is sweepable', () => {
    const result = calculateSweepable({
      contractBalance: '999.0000000',
      streams: [],
    });
    expect(result.totalLiabilities).toBe('0.0000000');
    expect(result.sweepableAmount).toBe('999.0000000');
  });

  it('multiple streams — liabilities are summed', () => {
    const result = calculateSweepable({
      contractBalance: '1000.0000000',
      streams: [
        makeStream({ id: 's1', status: 'active',    depositAmount: '300.0000000' }),
        makeStream({ id: 's2', status: 'paused',    depositAmount: '200.0000000' }),
        makeStream({ id: 's3', status: 'cancelled', depositAmount: '100.0000000' }),
        makeStream({ id: 's4', status: 'completed', depositAmount: '150.0000000' }),
      ],
    });
    expect(result.totalLiabilities).toBe('750.0000000');
    expect(result.sweepableAmount).toBe('250.0000000');
  });

  it('liabilities exceed balance — sweepable is 0, not negative', () => {
    const result = calculateSweepable({
      contractBalance: '50.0000000',
      streams: [makeStream({ id: 's1', status: 'active', depositAmount: '100.0000000' })],
    });
    expect(result.sweepableAmount).toBe('0.0000000');
  });

  it('throws on malformed contractBalance', () => {
    expect(() =>
      calculateSweepable({ contractBalance: 'not-a-number', streams: [] }),
    ).toThrow();
  });
});

// ─── Unit: validateSweepRequest ──────────────────────────────────────────────

describe('validateSweepRequest', () => {
  const sweepResult = {
    sweepableAmount: '50.0000000',
    totalLiabilities: '100.0000000',
    contractBalance: '150.0000000',
  };

  it('allows amount equal to sweepable', () => {
    const result = validateSweepRequest('50.0000000', sweepResult);
    expect(result.ok).toBe(true);
  });

  it('allows amount less than sweepable', () => {
    const result = validateSweepRequest('10.0000000', sweepResult);
    expect(result.ok).toBe(true);
  });

  it('blocks amount exceeding sweepable', () => {
    const result = validateSweepRequest('51.0000000', sweepResult);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(result.error.message).toContain('51.0000000');
    }
  });

  it('returns INVALID_INPUT for malformed requestedAmount', () => {
    const result = validateSweepRequest('abc', sweepResult);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  });
});

// ─── Integration: POST /api/admin/sweep ──────────────────────────────────────

const ADMIN_KEY = 'test-admin-key';

describe('POST /api/admin/sweep', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    // Clear in-memory streams between tests
    streams.splice(0, streams.length);
  });

  it('returns 401 without auth header', async () => {
    const res = await request(app).post('/api/admin/sweep').send({
      contractBalance: '100.0000000',
      requestedAmount: '10.0000000',
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 with wrong token', async () => {
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', 'Bearer wrong-key')
      .send({ contractBalance: '100.0000000', requestedAmount: '10.0000000' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when contractBalance is missing', async () => {
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ requestedAmount: '10.0000000' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when requestedAmount is missing', async () => {
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contractBalance: '100.0000000' });
    expect(res.status).toBe(400);
  });

  it('200 — no streams, entire balance sweepable', async () => {
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contractBalance: '100.0000000', requestedAmount: '100.0000000' });
    expect(res.status).toBe(200);
    expect(res.body.sweepableAmount).toBe('100.0000000');
    expect(res.body.totalLiabilities).toBe('0.0000000');
  });

  it('200 — active stream, only excess is sweepable', async () => {
    streams.push(makeStream({ id: 's1', status: 'active', depositAmount: '60.0000000' }));
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contractBalance: '100.0000000', requestedAmount: '40.0000000' });
    expect(res.status).toBe(200);
    expect(res.body.sweepableAmount).toBe('40.0000000');
    expect(res.body.totalLiabilities).toBe('60.0000000');
  });

  it('400 — requested amount exceeds sweepable (invariant violation)', async () => {
    streams.push(makeStream({ id: 's1', status: 'active', depositAmount: '80.0000000' }));
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contractBalance: '100.0000000', requestedAmount: '30.0000000' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('400 — cancelled stream with undrawn accrual blocks over-sweep', async () => {
    streams.push(makeStream({ id: 's1', status: 'cancelled', depositAmount: '90.0000000' }));
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contractBalance: '100.0000000', requestedAmount: '20.0000000' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('400 — completed stream awaiting close blocks over-sweep', async () => {
    streams.push(makeStream({ id: 's1', status: 'completed', depositAmount: '95.0000000' }));
    const res = await request(app)
      .post('/api/admin/sweep')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contractBalance: '100.0000000', requestedAmount: '10.0000000' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
  });
});
