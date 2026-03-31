import request from 'supertest';
import  app  from '../src/app.js';
import * as StellarService from '../src/lib/stellar.js';
import { vi as jest } from 'vitest';
import { parseToStroops } from '../src/serialization/decimal.js';

// Mock the Stellar service to avoid real network calls
jest.spyOn(StellarService, 'verifyStreamOnChain');

describe('POST /api/streams (Chain-First)', () => {
  const transactionHash = 'a1b2c3d4e5f6g7h8i9j0';
  const authToken = 'valid-token'; // Simplified for test

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a stream when transaction is verified on-chain', async () => {
    const mockVerifiedStream = {
      sender: 'GCSX2...',
      recipient: 'GDRX2...',
      depositAmount: parseToStroops('100.0000000'),
      ratePerSecond: parseToStroops('0.0000116'),
      startTime: 1700000000,
      endTime: 0,
    };

    (StellarService.verifyStreamOnChain as any).mockResolvedValue(mockVerifiedStream);

    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transactionHash });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(`stream-${transactionHash.slice(0, 8)}`);
    expect(res.body.sender).toBe(mockVerifiedStream.sender);
    expect(StellarService.verifyStreamOnChain).toHaveBeenCalledWith(transactionHash);
  });

  it('should return 404 when transaction is not found on Stellar', async () => {
    const error = new Error('Not Found');
    (error as any).response = { status: 404 };
    (StellarService.verifyStreamOnChain as any).mockRejectedValue(error);

    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transactionHash: 'invalid-hash' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('transaction_not_found');
  });

  it('should return 400 when transactionHash is missing', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 503 when Stellar Horizon is down', async () => {
    (StellarService.verifyStreamOnChain as any).mockRejectedValue(new Error('Network Error'));

    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transactionHash });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('service_unavailable');
  });

  it('should return 200 for duplicate transaction hashes (idempotency)', async () => {
    const mockVerifiedStream = {
      sender: 'GCSX2...',
      recipient: 'GDRX2...',
      depositAmount: parseToStroops('100.0000000'),
      ratePerSecond: parseToStroops('0.0000116'),
      startTime: 1700000000,
      endTime: 0,
    };

    (StellarService.verifyStreamOnChain as any).mockResolvedValue(mockVerifiedStream);

    // First call
    await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transactionHash });

    // Second call
    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transactionHash });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(`stream-${transactionHash.slice(0, 8)}`);
  });
});
