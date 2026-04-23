import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { _resetStreams } from '../../src/routes/streams.js';

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';
const INVALID_STELLAR_KEY_SHORT = 'GABC123';
const INVALID_STELLAR_KEY_WRONG_PREFIX = 'AAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const INVALID_STELLAR_KEY_INVALID_CHARS = 'G1111111111111111111111111111111111111111111111111111111';

const app = createApp();

describe('streams routes', () => {
  beforeEach(() => {
    _resetStreams();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/streams', () => {
    it('returns an empty list initially', async () => {
      const res = await request(app).get('/api/streams');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.streams).toEqual([]);
    });
  });

  describe('POST /api/streams', () => {
    const validBody = {
      sender: VALID_SENDER,
      recipient: VALID_RECIPIENT,
      depositAmount: '1000',
      ratePerSecond: '10',
    };

    it('creates a stream with valid input', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sender).toBe(VALID_SENDER);
      expect(res.body.data.recipient).toBe(VALID_RECIPIENT);
      expect(res.body.data.depositAmount).toBe('1000');
      expect(res.body.data.ratePerSecond).toBe('10');
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.id).toMatch(/^stream-/);
      expect(typeof res.body.data.startTime).toBe('number');
    });

    it('accepts an explicit startTime', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, startTime: 1700000000 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.startTime).toBe(1700000000);
    });

    it('rejects missing sender', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: undefined });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('sender is required');
    });

    it('rejects empty sender', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender format - too short', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: INVALID_STELLAR_KEY_SHORT });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender format - wrong prefix', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: INVALID_STELLAR_KEY_WRONG_PREFIX });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender format - invalid characters', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: INVALID_STELLAR_KEY_INVALID_CHARS });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender format - generic string', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: 'not-a-stellar-key' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects missing recipient', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, recipient: undefined });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('recipient is required');
    });

    it('rejects empty recipient', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, recipient: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects invalid recipient format - too short', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, recipient: INVALID_STELLAR_KEY_SHORT });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects invalid recipient format - wrong prefix', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, recipient: INVALID_STELLAR_KEY_WRONG_PREFIX });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects non-positive depositAmount', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, depositAmount: '0' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('depositAmount must be a positive numeric string');
    });

    it('rejects non-numeric depositAmount', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, depositAmount: 'abc' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects negative ratePerSecond', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, ratePerSecond: '-5' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('ratePerSecond must be a positive numeric string');
    });

    it('rejects negative startTime', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, startTime: -1 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toContain('startTime must be a non-negative number');
    });

    it('returns all validation errors at once', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(2); // At least sender and recipient required
    });

    it('does not log raw Stellar keys after creation', async () => {
      const logSpy = vi.spyOn(console, 'log');

      await request(app)
        .post('/api/streams')
        .send(validBody);

      const allOutput = logSpy.mock.calls.map((c) => c[0] as string).join(' ');
      expect(allOutput).not.toContain(VALID_SENDER);
      expect(allOutput).not.toContain(VALID_RECIPIENT);
    });
  });

  describe('GET /api/streams/:id', () => {
    it('returns 404 for non-existent stream', async () => {
      const res = await request(app).get('/api/streams/stream-nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Stream');
    });

    it('returns a previously created stream', async () => {
      const createRes = await request(app)
        .post('/api/streams')
        .send({
          sender: VALID_SENDER,
          recipient: VALID_RECIPIENT,
          depositAmount: '500',
          ratePerSecond: '5',
        });

      const id = createRes.body.data.id;
      const getRes = await request(app).get(`/api/streams/${id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.success).toBe(true);
      expect(getRes.body.data.stream.id).toBe(id);
      expect(getRes.body.data.stream.sender).toBe(VALID_SENDER);
    });
  });
});
