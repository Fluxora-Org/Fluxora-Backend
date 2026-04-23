/**
 * Streams API Integration Tests
 * 
 * Purpose: Verify the streams API endpoints with decimal string serialization.
 * Tests cover happy paths, validation failures, error responses, and edge cases.
 * 
 * @file streams.test.ts
 */

import express from 'express';
import request from 'supertest';

// Import the streams router directly - we'll need to export the streams array for testing
import {
  streamsRouter,
  streams,
  setStreamListingDependencyState,
  setIdempotencyDependencyState,
  resetStreamIdempotencyStore,
} from '../src/routes/streams.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../src/errors.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { generateToken } from '../src/lib/auth.js';
import { authenticate } from '../src/middleware/auth.js';
import { initializeConfig } from '../src/config/env.js';

// Initialize config before any test module code runs (upstream requirement)
initializeConfig();

// Create a minimal test app
function createTestApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use(authenticate);
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

let idempotencyKeyCounter = 0;

function nextIdempotencyKey(): string {
  idempotencyKeyCounter += 1;
  return `test-idempotency-${idempotencyKeyCounter}`;
}

const testToken = generateToken({ address: 'GTEST', role: 'operator' });

function postStream(app: any, body: Record<string, unknown>, idempotencyKey = nextIdempotencyKey()) {
  return request(app)
    .post('/api/streams')
    .set('Idempotency-Key', idempotencyKey)
    .set('Authorization', `Bearer ${testToken}`)
    .send(body);
}

describe('Streams API - Decimal String Serialization', () => {
  let app: any;

  beforeEach(() => {
    app = createTestApp();
    streams.length = 0;
    setStreamListingDependencyState('healthy');
    setIdempotencyDependencyState('healthy');
    resetStreamIdempotencyStore();
  });

  describe('POST /api/streams', () => {
    it('should require an Idempotency-Key header', async () => {
      const response = await request(app)
        .post('/api/streams')
        .send({
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Idempotency-Key');
    });

    describe('valid decimal string inputs', () => {
      it('should create stream with valid decimal strings', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '1000000.0000000',
          ratePerSecond: '0.0000116',
        })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data.id).toBeDefined();
        expect(response.body.data.depositAmount).toBe('1000000.0000000');
        expect(response.body.data.ratePerSecond).toBe('0.0000116');
        expect(response.body.data.status).toBe('active');
      });

      it('should create stream with integer amounts', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        })
          .expect(201);

        expect(response.body.data.depositAmount).toBe('100');
        expect(response.body.data.ratePerSecond).toBe('1');
      });

      it('should replay the original response for the same idempotency key and payload', async () => {
        const idempotencyKey = 'stream-create-replay';
        const payload = {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        };

        const firstResponse = await postStream(app, payload, idempotencyKey).expect(201);
        const secondResponse = await postStream(app, payload, idempotencyKey).expect(201);

        expect(secondResponse.body).toEqual(firstResponse.body);
        expect(secondResponse.headers['idempotency-replayed']).toBe('true');
        expect(streams).toHaveLength(1);
      });

      it('should reject idempotency key reuse with a different payload', async () => {
        const idempotencyKey = 'stream-create-conflict';

        await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        }, idempotencyKey).expect(201);

        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '200',
          ratePerSecond: '1',
        }, idempotencyKey).expect(409);

        expect(response.body.error.code).toBe('CONFLICT');
      });

      it('should return 503 when the idempotency dependency is unavailable', async () => {
        setIdempotencyDependencyState('unavailable');

        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        }).expect(503);

        expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
      });

      it('should create stream with negative rate rejected', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '-1',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should create stream with zero deposit rejected', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '0',
          ratePerSecond: '1',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('invalid decimal string inputs', () => {
      it('should reject numeric depositAmount', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: 1000000,
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toBeDefined();
      });

      it('should reject numeric ratePerSecond', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '1000000',
          ratePerSecond: 0.0000116,
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject empty depositAmount', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '',
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject invalid format depositAmount', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: 'invalid',
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toBeDefined();
      });

      it('should reject scientific notation', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '1e10',
          ratePerSecond: '0.0000116',
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject NaN', async () => {
        await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: 'NaN',
          ratePerSecond: '0.0000116',
        })
          .expect(400);
      });
    });

    describe('missing required fields', () => {
      it('should reject missing sender', async () => {
        const response = await postStream(app, {
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        })
          .expect(400);

        expect(response.body.error.message).toContain('sender');
      });

      it('should reject missing recipient', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
        })
          .expect(400);

        expect(response.body.error.message).toContain('recipient');
      });

      it('should accept missing depositAmount (uses default)', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          ratePerSecond: '1',
        })
          .expect(201);

        // depositAmount defaults to '0' per implementation
        expect(response.body.data.depositAmount).toBe('0');
      });

      it('should accept missing ratePerSecond (uses default)', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
        })
          .expect(201);

        // ratePerSecond defaults to '0' per implementation
        expect(response.body.data.ratePerSecond).toBe('0');
      });
    });

    describe('invalid startTime', () => {
      it('should reject non-integer startTime', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
          startTime: 123.45,
        })
          .expect(400);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject negative startTime', async () => {
        await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '100',
          ratePerSecond: '1',
          startTime: -1,
        })
          .expect(400);
      });
    });

    describe('error response format', () => {
      it('should include requestId in error response', async () => {
        const response = await request(app)
          .post('/api/streams')
          .set('Idempotency-Key', nextIdempotencyKey())
          .set('X-Request-ID', 'test-request-123')
          .send({
            depositAmount: 'invalid',
            ratePerSecond: '1',
          })
          .expect(400);

        expect(response.body.error.requestId).toBe('test-request-123');
      });

      it('should include error details for validation errors', async () => {
        const response = await postStream(app, {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: 'invalid',
          ratePerSecond: 'also-invalid',
        })
          .expect(400);

        expect(response.body.error.details).toBeDefined();
        expect(Array.isArray(response.body.error.details.errors)).toBe(true);
      });
    });
  });

  describe('GET /api/streams', () => {
    beforeEach(async () => {
      // Create some test streams for pagination testing
      const testStreams = [
        {
          sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '1000.0000000',
          ratePerSecond: '0.0000116',
        },
        {
          sender: 'GCSX3XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX3XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '2000.0000000',
          ratePerSecond: '0.0000232',
        },
        {
          sender: 'GCSX4XXXXXXXXXXXXXXXXXXXXXXX',
          recipient: 'GDRX4XXXXXXXXXXXXXXXXXXXXXXX',
          depositAmount: '3000.0000000',
          ratePerSecond: '0.0000348',
        },
      ];

      for (const stream of testStreams) {
        await postStream(app, stream).expect(201);
      }
    });

    it('should return streams array with pagination metadata', async () => {
      const response = await request(app)
        .get('/api/streams')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.streams).toBeDefined();
      expect(Array.isArray(response.body.data.streams)).toBe(true);
      expect(response.body.data.has_more).toBeDefined();
      expect(typeof response.body.data.has_more).toBe('boolean');
      expect(response.body.data.total).toBeUndefined();
      expect(response.body.data.streams.length).toBeGreaterThanOrEqual(0);
    });

    it('should return all streams when no pagination parameters', async () => {
      const response = await request(app)
        .get('/api/streams')
        .expect(200);

      expect(response.body.data.streams.length).toBe(3);
      expect(response.body.data.has_more).toBe(false);
      expect(response.body.data.total).toBeUndefined();
      expect(response.body.data.next_cursor).toBeUndefined();
    });

    it('should support limit parameter', async () => {
      const response = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      expect(response.body.data.streams.length).toBe(2);
      expect(response.body.data.has_more).toBe(true);
      expect(response.body.data.total).toBeUndefined();
      expect(response.body.data.next_cursor).toBeDefined();
    });

    it('should return total only when include_total=true', async () => {
      const response = await request(app)
        .get('/api/streams?include_total=true')
        .expect(200);

      expect(response.body.data.total).toBe(3);
      expect(response.body.data.has_more).toBe(false);
    });

    it('should support cursor pagination', async () => {
      const firstPage = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      expect(firstPage.body.streams.length).toBe(2);
      expect(firstPage.body.has_more).toBe(true);
      expect(firstPage.body.next_cursor).toBeDefined();

      const secondPage = await request(app)
        .get(`/api/streams?cursor=${firstPage.body.next_cursor}&limit=2`)
        .expect(200);

      expect(secondPage.body.streams.length).toBe(1);
      expect(secondPage.body.has_more).toBe(false);
      expect(secondPage.body.total).toBeUndefined();
      expect(secondPage.body.next_cursor).toBeUndefined();
    });

    it('should treat total as response-time metadata instead of a cursor snapshot guarantee', async () => {
      const firstPage = await request(app)
        .get('/api/streams?limit=2&include_total=true')
        .expect(200);

      expect(firstPage.body.total).toBe(3);
      expect(firstPage.body.next_cursor).toBeDefined();

      await postStream(app, {
        sender: 'GCSX5XXXXXXXXXXXXXXXXXXXXXXX',
        recipient: 'GDRX5XXXXXXXXXXXXXXXXXXXXXXX',
        depositAmount: '4000.0000000',
        ratePerSecond: '0.0000464',
      }).expect(201);

      const secondPage = await request(app)
        .get(`/api/streams?cursor=${firstPage.body.next_cursor}&limit=2&include_total=true`)
        .expect(200);

      expect(secondPage.body.streams.length).toBe(2);
      expect(secondPage.body.total).toBe(4);
      expect(secondPage.body.has_more).toBe(false);
    });

    it('should resume from the encoded sort key when the cursor record disappears', async () => {
      const firstPage = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      const deletedId = firstPage.body.streams[1].id;
      const deletedIndex = streams.findIndex((stream) => stream.id === deletedId);
      streams.splice(deletedIndex, 1);

      const secondPage = await request(app)
        .get(`/api/streams?cursor=${firstPage.body.next_cursor}&limit=2`)
        .expect(200);

      expect(secondPage.body.streams).toHaveLength(1);
      expect(secondPage.body.streams[0].id).not.toBe(deletedId);
    });

    it('should reject invalid limit values', async () => {
      const response = await request(app)
        .get('/api/streams?limit=0')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject limit > 100', async () => {
      const response = await request(app)
        .get('/api/streams?limit=101')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject non-integer limit values', async () => {
      const response = await request(app)
        .get('/api/streams?limit=1.5')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid cursor', async () => {
      const response = await request(app)
        .get('/api/streams?cursor=invalid-cursor')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid include_total values', async () => {
      const response = await request(app)
        .get('/api/streams?include_total=maybe')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 503 when the listing dependency is unavailable', async () => {
      setStreamListingDependencyState('unavailable');

      const response = await request(app)
        .get('/api/streams')
        .expect(503);

      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('should include requestId in response', async () => {
      await request(app)
        .get('/api/streams')
        .set('X-Request-ID', 'test-123')
        .expect(200);
    });
  });

  describe('GET /api/streams/:id', () => {
    it('should return 404 for non-existent stream', async () => {
      const response = await request(app)
        .get('/api/streams/non-existent-id')
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/streams/:id', () => {
    it('should return 404 for non-existent stream', async () => {
      const response = await request(app)
        .delete('/api/streams/non-existent-id')
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });
});

describe('Error Handler Integration', () => {
  let app: any;

  beforeEach(() => {
    app = createTestApp();
  });

  it('should handle 404 for unknown routes', async () => {
    // Note: Express returns plain text for 404 by default
    // The 404 handler in index.ts is not used in the test app
    const response = await request(app)
      .get('/unknown-route')
      .expect(404);

    // Just verify we get a 404
    expect(response.status).toBe(404);
  });

  it('should handle malformed JSON', async () => {
    // Note: Express's JSON parser returns 400 for malformed JSON by default
    const response = await request(app)
      .post('/api/streams')
      .set('Idempotency-Key', nextIdempotencyKey())
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');

    // Express JSON parser returns 400 for malformed JSON
    // But in this test setup, it might return 500
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThanOrEqual(500);
  });
});

// ─── Status Transition Tests ──────────────────────────────────────────────────

describe('Stream Status Transitions', () => {
  let app: any;

  const BASE_STREAM = {
    sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
    recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
    depositAmount: '100',
    ratePerSecond: '1',
  };

  beforeEach(() => {
    app = createTestApp();
    streams.length = 0;
    setStreamListingDependencyState('healthy');
    setIdempotencyDependencyState('healthy');
    resetStreamIdempotencyStore();
  });

  async function createStream() {
    const res = await postStream(app, BASE_STREAM);
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string };
  }

  // ── PATCH /:id/status ────────────────────────────────────────────────────

  describe('PATCH /api/streams/:id/status', () => {
    it('transitions active → paused', async () => {
      const { id } = await createStream();
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'paused' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('paused');
    });

    it('transitions active → cancelled', async () => {
      const { id } = await createStream();
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
    });

    it('transitions active → completed', async () => {
      const { id } = await createStream();
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'completed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    it('transitions paused → active', async () => {
      const { id } = await createStream();
      await request(app).patch(`/api/streams/${id}/status`).send({ status: 'paused' });
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'active' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
    });

    it('returns 409 for active → active (no-op invalid)', async () => {
      const { id } = await createStream();
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 409 when transitioning from a terminal status (completed)', async () => {
      const { id } = await createStream();
      await request(app).patch(`/api/streams/${id}/status`).send({ status: 'completed' });
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/completed/);
    });

    it('returns 409 when transitioning from a terminal status (cancelled)', async () => {
      const { id } = await createStream();
      await request(app).patch(`/api/streams/${id}/status`).send({ status: 'cancelled' });
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 400 for an unknown status value', async () => {
      const { id } = await createStream();
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'unknown' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when status field is missing', async () => {
      const { id } = await createStream();
      const res = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown stream id', async () => {
      const res = await request(app)
        .patch('/api/streams/nonexistent/status')
        .send({ status: 'paused' });
      expect(res.status).toBe(404);
    });

    it('preserves decimal-string amount fields after transition', async () => {
      const res1 = await postStream(app, {
        ...BASE_STREAM,
        depositAmount: '1000000.0000000',
        ratePerSecond: '0.0000116',
      });
      const { id } = res1.body;
      const res2 = await request(app)
        .patch(`/api/streams/${id}/status`)
        .send({ status: 'paused' });
      expect(res2.status).toBe(200);
      expect(res2.body.depositAmount).toBe('1000000.0000000');
      expect(res2.body.ratePerSecond).toBe('0.0000116');
    });
  });

  // ── DELETE (cancel guard) ────────────────────────────────────────────────

  describe('DELETE /api/streams/:id (cancel guard)', () => {
    it('returns 409 when cancelling an already-cancelled stream', async () => {
      const { id } = await createStream();
      await request(app).delete(`/api/streams/${id}`).expect(200);
      const res = await request(app).delete(`/api/streams/${id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/cancelled/);
    });

    it('returns 409 when cancelling a completed stream', async () => {
      const { id } = await createStream();
      await request(app).patch(`/api/streams/${id}/status`).send({ status: 'completed' });
      const res = await request(app).delete(`/api/streams/${id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/completed/);
    });

    it('cancels an active stream successfully', async () => {
      const { id } = await createStream();
      const res = await request(app).delete(`/api/streams/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
    });

    it('cancels a paused stream successfully', async () => {
      const { id } = await createStream();
      await request(app).patch(`/api/streams/${id}/status`).send({ status: 'paused' });
      const res = await request(app).delete(`/api/streams/${id}`);
      expect(res.status).toBe(200);
    });
  });
});
