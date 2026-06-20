import express from 'express';
import request from 'supertest';
import { createIdempotencyMiddleware } from '../../../src/middleware/idempotency.js';
import { InMemoryIdempotencyStore } from '../../../src/redis/idempotencyStore.js';
import { IdempotencyConflictSchema } from '../../../src/validation/idempotency.js';

describe('Idempotency Middleware', () => {
  let app: express.Express;
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(createIdempotencyMiddleware(store));

    app.post('/test', (req, res) => {
      res.status(201).json({ message: 'success', data: req.body });
    });
  });

  it('should process a fresh request and cache it', async () => {
    const body = { foo: 'bar' };
    const response = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-1')
      .send(body);

    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('false');
    expect(response.body.data).toEqual(body);

    const cached = await store.get('test-key-1');
    expect(cached).not.toBeNull();
    expect(cached?.requestFingerprint).toBeDefined();
  });

  it('should return a replayed response on matching body', async () => {
    const body = { foo: 'bar' };
    await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-2')
      .send(body);

    const response = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-2')
      .send(body);

    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(response.body.data).toEqual(body);
    expect(response.body.meta.idempotencyReplayed).toBe(true);
  });

  it('should return 409 Conflict on mismatched body', async () => {
    await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-3')
      .send({ foo: 'bar' });

    const response = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-3')
      .send({ foo: 'baz' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('idempotency_conflict');
    expect(response.body.stored_hash).toBeDefined();
    expect(response.body.incoming_hash).toBeDefined();
    
    // Validate with schema
    IdempotencyConflictSchema.parse(response.body);
  });

  it('should normalize body: whitespace and key ordering', async () => {
    await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-4')
      .send({ a: 1, b: 2 });

    // Same content, different order
    const response = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-4')
      .send({ b: 2, a: 1 });

    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('true');
  });

  it('should handle very large bodies', async () => {
    const largeBody = { data: 'a'.repeat(100 * 1024) }; // 100KB
    const response1 = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-large')
      .send(largeBody);

    expect(response1.status).toBe(201);

    const response2 = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-large')
      .send(largeBody);

    expect(response2.status).toBe(201);
    expect(response2.headers['idempotency-replayed']).toBe('true');
  });

  it('should handle Redis eviction race (key missing on replay)', async () => {
    const body = { foo: 'bar' };
    await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-evicted')
      .send(body);

    // Manually clear the store to simulate eviction
    store.clear();

    const response = await request(app)
      .post('/test')
      .set('Idempotency-Key', 'test-key-evicted')
      .send(body);

    // Should treat as a fresh request
    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBe('false');
  });
});
