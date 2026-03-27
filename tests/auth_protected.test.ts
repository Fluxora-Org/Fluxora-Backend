import request from 'supertest';
import { app } from '../src/index.js';
import { generateToken } from '../src/lib/auth.js';

describe('Auth Protected Routes', () => {
  let token: string;
  const address = 'GCSX2...';

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
  });

  describe('Protected Streams Routes', () => {
    it('should allow listing streams without a token', async () => {
      const res = await request(app).get('/api/streams');
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
    });

    it('should allow stream creation with a valid token', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${token}`)
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
    });
  });
});
