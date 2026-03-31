import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { _resetStreams } from '../../src/routes/streams.js';

const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

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
      expect(res.body.streams).toEqual([]);
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
      expect(res.body.sender).toBe(VALID_SENDER);
      expect(res.body.recipient).toBe(VALID_RECIPIENT);
      expect(res.body.depositAmount).toBe('1000');
      expect(res.body.ratePerSecond).toBe('10');
      expect(res.body.status).toBe('active');
      expect(res.body.id).toMatch(/^stream-/);
      expect(typeof res.body.startTime).toBe('number');
    });

    it('accepts an explicit startTime', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, startTime: 1700000000 });

      expect(res.status).toBe(201);
      expect(res.body.startTime).toBe(1700000000);
    });

    it('rejects missing sender', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: undefined });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid sender format', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, sender: 'not-a-stellar-key' });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('sender must be a valid Stellar public key (G...)');
    });

    it('rejects invalid recipient format', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, recipient: '' });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('recipient must be a valid Stellar public key (G...)');
    });

    it('rejects non-positive depositAmount', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, depositAmount: '0' });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('depositAmount must be a positive numeric string');
    });

    it('rejects non-numeric depositAmount', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, depositAmount: 'abc' });

      expect(res.status).toBe(400);
    });

    it('rejects negative ratePerSecond', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, ratePerSecond: '-5' });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('ratePerSecond must be a positive numeric string');
    });

    it('rejects negative startTime', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ ...validBody, startTime: -1 });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('startTime must be a non-negative number');
    });

    it('returns all validation errors at once', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.details.length).toBeGreaterThanOrEqual(4);
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
      expect(res.body.error).toBe('Stream not found');
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

      const id = createRes.body.id;
      const getRes = await request(app).get(`/api/streams/${id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(id);
      expect(getRes.body.sender).toBe(VALID_SENDER);
    });
  });
});
