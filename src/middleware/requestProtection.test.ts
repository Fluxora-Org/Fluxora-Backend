import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';

describe('Request Protection Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json({ limit: '100b' })); // Very small limit for testing
    app.post('/test', (req, res) => res.json(req.body));
    app.use(errorHandler);
  });

  it('rejects payloads larger than the configured limit', async () => {
    const largeBody = { data: 'a'.repeat(200) };
    await request(app)
      .post('/test')
      .send(largeBody)
      .expect(413);
  });
});
