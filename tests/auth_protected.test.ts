import request from 'supertest';
import { app } from '../src/app.js';
import { generateToken } from '../src/lib/auth.js';

describe('Auth Protected Routes', () => {
  let token: string;
  const address = 'GCSX2...';

  let idempotencyCounter = 0;
  const nextKey = () => `auth-protected-key-${++idempotencyCounter}`;

  beforeAll(() => {
    token = generateToken({ address, role: 'operator' });
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
          sender: 'G1',
          recipient: 'G2',
          depositAmount: '100',
          ratePerSecond: '1'
        });
      
      const streamId = createRes.body.id;

      // Then get it without auth
      const res = await request(app).get(`/api/streams/${streamId}`);
      expect(res.status).toBe(200);
    });

    it('should deny stream creation without a token', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({
          sender: 'G1',
          recipient: 'G2',
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
          sender: 'G1',
          recipient: 'G2',
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
          sender: 'G1',
          recipient: 'G2',
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
          sender: 'G1',
          recipient: 'G2',
          depositAmount: '100',
          ratePerSecond: '1'
        });

      expect(res.status).toBe(201);
      expect(res.body.sender).toBe('G1');
    });

    it('should allow stream cancellation with a valid token', async () => {
      // First create a stream
      const createRes = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', nextKey())
        .send({
          sender: 'G1',
          recipient: 'G2',
          depositAmount: '100',
          ratePerSecond: '1'
        });
      
      const streamId = createRes.body.id;

      // Then cancel it
      const res = await request(app)
        .delete(`/api/streams/${streamId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Stream cancelled');
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
          sender: 'G1',
          recipient: 'G2',
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
