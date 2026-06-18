import request from 'supertest';
import { vi } from 'vitest';

// Mock the DB-backed repository so we do not need a live Postgres.
const mockGetById = vi.fn();
const mockUpsertStream = vi.fn();
const mockUpdateStream = vi.fn();
const mockFindWithCursor = vi.fn();
vi.mock('../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById:        (...a: unknown[]) => mockGetById(...a),
    upsertStream:   (...a: unknown[]) => mockUpsertStream(...a),
    updateStream:   (...a: unknown[]) => mockUpdateStream(...a),
    findWithCursor: (...a: unknown[]) => mockFindWithCursor(...a),
    countByStatus:  vi.fn().mockResolvedValue({ active: 0, paused: 0, completed: 0, cancelled: 0 }),
  },
}));
vi.mock('../src/db/pool.js', () => ({
  getPool:             vi.fn(() => ({})),
  query:               vi.fn(),
  PoolExhaustedError:  class PoolExhaustedError extends Error {},
  DuplicateEntryError: class DuplicateEntryError extends Error {},
}));

import { app } from '../src/app.js';
import { generateToken } from '../src/lib/auth.js';
import { initializeConfig } from '../src/config/env.js';

describe('Auth Protected Routes', () => {
  let token: string;
  const address = 'GCSX22222222222222222222222222222222222222222222222222UV';

  let idempotencyCounter = 0;
  const nextKey = () => `auth-protected-key-${++idempotencyCounter}`;

  const storedById = new Map<string, Record<string, unknown>>();

  beforeAll(() => {
    initializeConfig();
    token = generateToken({ address, role: 'operator' });
  });

  beforeEach(() => {
    storedById.clear();
    mockGetById.mockImplementation(async (id: string) => storedById.get(id));
    mockUpsertStream.mockImplementation(async (input: { id: string }) => {
      const record = {
        id: input.id,
        sender_address: address,
        recipient_address: address,
        amount: '100',
        streamed_amount: '0',
        remaining_amount: '100',
        rate_per_second: '1',
        start_time: 0,
        end_time: 0,
        status: 'active',
        contract_id: 'api-created',
        transaction_hash: 'a'.repeat(64),
        event_index: 0,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      storedById.set(input.id, record);
      return { created: true, stream: record };
    });
    mockUpdateStream.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => {
        const existing = storedById.get(id) ?? { id, status: 'active' };
        const updated = { ...existing, ...patch };
        storedById.set(id, updated);
        return updated;
      },
    );
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
  });

  describe('POST /api/auth/session', () => {
    it('should create a session and return a token', async () => {
      const res = await request(app)
        .post('/api/auth/session')
        .send({ address, role: 'operator' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.address).toBe(address);
    });

    it('should return 400 for invalid input', async () => {
      const res = await request(app)
        .post('/api/auth/session')
        .send({ address: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should default role to viewer when not specified', async () => {
      const res = await request(app)
        .post('/api/auth/session')
        .send({ address });

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('viewer');
    });
  });

  describe('Protected Streams Routes', () => {
    it('should allow listing streams without a token', async () => {
      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(200);
    });

    it('should allow getting a stream without a token', async () => {
      // First create a stream with auth
      const createRes = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', nextKey())
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });
      
      const streamId = createRes.body.data.id;

      // Then get it without auth
      const res = await request(app).get(`/api/streams/${streamId}`);
      expect(res.status).toBe(200);
    });

    it('should deny stream creation without a token', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toContain('Authentication required');
    });

    it('should deny stream creation with an invalid token', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Authorization', 'Bearer invalid-token')
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toContain('Invalid or expired');
    });

    it('should deny stream creation with malformed Authorization header', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Authorization', 'InvalidFormat')
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('should allow stream creation with a valid token', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', nextKey())
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });

      expect(res.status).toBe(201);
      expect(res.body.data.sender).toBe(
        'GCSX22222222222222222222222222222222222222222222222222UV',
      );
    });

    it('should allow stream cancellation with a valid token', async () => {
      // First create a stream
      const createRes = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', nextKey())
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });
      
      const streamId = createRes.body.data.id;

      // Then cancel it
      const res = await request(app)
        .delete(`/api/streams/${streamId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Stream cancelled');
    });

    it('should deny stream cancellation without a token', async () => {
       const res = await request(app)
        .delete('/api/streams/some-id');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('should deny stream cancellation with invalid token', async () => {
      const res = await request(app)
        .delete('/api/streams/some-id')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Admin Routes Protection', () => {
    const adminKey = 'test-admin-key-12345';
    let originalAdminKey: string | undefined;

    beforeAll(() => {
      originalAdminKey = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = adminKey;
    });

    afterAll(() => {
      if (originalAdminKey !== undefined) {
        process.env.ADMIN_API_KEY = originalAdminKey;
      } else {
        delete process.env.ADMIN_API_KEY;
      }
    });

    it('should deny admin status without admin auth', async () => {
      const res = await request(app).get('/api/admin/status');
      expect(res.status).toBe(401);
    });

    it('should deny admin status with invalid admin key', async () => {
      const res = await request(app)
        .get('/api/admin/status')
        .set('Authorization', 'Bearer wrong-key');
      expect(res.status).toBe(403);
    });

    it('should allow admin status with valid admin key', async () => {
      const res = await request(app)
        .get('/api/admin/status')
        .set('Authorization', `Bearer ${adminKey}`);
      expect(res.status).toBe(200);
      expect(res.body.pauseFlags).toBeDefined();
    });

    it('should deny admin pause update without admin auth', async () => {
      const res = await request(app)
        .put('/api/admin/pause')
        .send({ streamCreation: true });
      expect(res.status).toBe(401);
    });

    it('should allow admin pause update with valid admin key', async () => {
      const res = await request(app)
        .put('/api/admin/pause')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ streamCreation: true });
      expect(res.status).toBe(200);
    });
  });

  describe('Error Response Format', () => {
    it('should return consistent error envelope for 401', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({
          sender: 'GCSX22222222222222222222222222222222222222222222222222UV',
          recipient: 'GDRX22222222222222222222222222222222222222222222222222UV',
          depositAmount: '100',
          ratePerSecond: '1'
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBeDefined();
      expect(typeof res.body.error.message).toBe('string');
    });
  });
});
