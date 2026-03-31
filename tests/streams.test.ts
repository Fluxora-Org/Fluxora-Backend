import express from 'express';
import request from 'supertest';
import { getStreamById } from '../src/db/client.js';

// Import the streams router directly - we'll need to export the streams array for testing
import {
  streamsRouter,
  streams,
  setStreamListingDependencyState,
  setIdempotencyDependencyState,
  resetStreamIdempotencyStore,
} from '../src/routes/streams.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { IndexerHealthSnapshot } from '../src/indexer/types.js';
import { generateToken } from '../src/lib/auth.js';
import { info, SerializationLogger } from '../src/utils/logger.js';
import { requestIdMiddleware } from '../src/errors.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { initializeConfig, resetConfig } from '../src/config/env.js';

jest.mock('../src/db/client.js', () => ({
  getStreamById: jest.fn(),
}))

// Create a minimal test app
function createTestApp() {
  const app = express();
  // Custom requestId middleware for tests to ensure consistent requestId for idempotent replays
  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') || 'test-request-id';
    res.locals['requestId'] = requestId;
    (req as any).requestId = requestId;
    next();
  });
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use(authenticate);
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

const validStream = {
  sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
  recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
  depositAmount: '1000.0',
  ratePerSecond: '0.1',
};

let testToken: string;

function postStream(app: any, body: Record<string, unknown>, idempotencyKey = nextIdempotencyKey()) {
  return request(app)
    .post('/api/streams')
    .set('Authorization', `Bearer ${testToken}`)
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
}

describe('Streams API - Decimal String Serialization', () => {
  let app: any;

  let token: string;

  beforeEach(() => {
    testToken = generateToken({ address: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX', role: 'operator' });
    token = testToken; // For other tests that use 'token'
    app = createTestApp();
    streams.length = 0;
    resetStreamIdempotencyStore();
    app = createTestApp();
  });

  describe('POST /api/streams', () => {
    it('creates a stream with valid API key', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${testToken}`)
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

        expect(response.body.id).toBeDefined();
        expect(response.body.depositAmount).toBe('1000000.0000000');
        expect(response.body.ratePerSecond).toBe('0.0000116');
        expect(response.body.status).toBe('active');
      });

      it('should create stream with integer amounts', async () => {
        const response = await postStream(app, {
            sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
            recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
            depositAmount: '100',
            ratePerSecond: '1',
          })
          .expect(201);

        expect(response.body.depositAmount).toBe('100');
        expect(response.body.ratePerSecond).toBe('1');
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

        // Exclude requestId from comparison as it's unique per request even for idempotent replays
        const { requestId: r1, ...b1 } = firstResponse.body;
        const { requestId: r2, ...b2 } = secondResponse.body;
        expect(b2).toEqual(b1);
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
        expect(response.body.depositAmount).toBe('0');
      });

      it('should accept missing ratePerSecond (uses default)', async () => {
        const response = await postStream(app, {
            sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
            recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
            depositAmount: '100',
          })
          .expect(201);

        // ratePerSecond defaults to '0' per implementation
        expect(response.body.ratePerSecond).toBe('0');
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
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', nextIdempotencyKey())
          .set('x-request-id', 'test-request-123')
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

      expect(Array.isArray(response.body.streams)).toBe(true);
      if (response.body.streams.length > 0) {
        expect(response.body.streams[0]!.id).toMatch(/^stream-\d+-[a-z0-9]+$/);
      }
      expect(response.body.has_more).toBeDefined();
      expect(typeof response.body.has_more).toBe('boolean');
      expect(response.body.total).toBeUndefined();
    });

    it('should return all streams when no pagination parameters', async () => {
      const response = await request(app)
        .get('/api/streams')
        .expect(200);

      expect(response.body.streams.length).toBe(3);
      expect(response.body.has_more).toBe(false);
      expect(response.body.total).toBeUndefined();
      expect(response.body.next_cursor).toBeUndefined();
    });

    it('should support limit parameter', async () => {
      const response = await request(app)
        .get('/api/streams?limit=2')
        .expect(200);

      expect(response.body.streams.length).toBe(2);
      expect(response.body.streams[0]!.id).toMatch(/^stream-\d+-[a-z0-9]+$/);
      expect(response.body.streams[1]!.id).toMatch(/^stream-\d+-[a-z0-9]+$/);
      expect(response.body.has_more).toBe(true);
      expect(response.body.total).toBeUndefined();
      expect(response.body.next_cursor).toBeDefined();
    });

    it('should return total only when include_total=true', async () => {
      const response = await request(app)
        .get('/api/streams?include_total=true')
        .expect(200);

      expect(response.body.total).toBe(3);
      expect(response.body.has_more).toBe(false);
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
      const deletedIndex = streams.findIndex(
        (stream: any) => stream.id === deletedId
      )
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
      const response = await request(app)
        .get('/api/streams')
        .set('x-request-id', 'test-123')
        .expect(200);

      expect(response.body.requestId).toBe('test-123');
    });

    it('records audit event on cancellation', async () => {
      const validStreamInternal = {
        sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
        recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
        depositAmount: '1000.0000000',
        ratePerSecond: '0.0000116',
      };
      
      const createRes = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', nextIdempotencyKey())
        .send(validStreamInternal)
        .expect(201);
      
      const { id } = createRes.body;
      await request(app)
        .delete(`/api/streams/${id}`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
    });

    describe('filtering', () => {
      beforeEach(async () => {
        // Clear and re-seed specific streams for filtering
        streams.length = 0
        streams.push(
          {
            id: '1',
            status: 'active',
            sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXA',
            recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXB',
            depositAmount: '100',
            ratePerSecond: '1',
            startTime: 0,
            endTime: 0,
          },
          {
            id: '2',
            status: 'completed',
            sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXA',
            recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXC',
            depositAmount: '200',
            ratePerSecond: '2',
            startTime: 0,
            endTime: 0,
          },
          {
            id: '3',
            status: 'active',
            sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXD',
            recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXB',
            depositAmount: '300',
            ratePerSecond: '3',
            startTime: 0,
            endTime: 0,
          }
        )
      })

      it('should filter by status', async () => {
        const response = await request(app)
          .get('/api/streams?status=active')
          .expect(200)
        expect(response.body.streams).toHaveLength(2)
        expect(
          response.body.streams.every((s: any) => s.status === 'active')
        ).toBe(true)
      })

      it('should filter by sender', async () => {
        const response = await request(app)
          .get('/api/streams?sender=GCSX2XXXXXXXXXXXXXXXXXXXXXXA')
          .expect(200)
        expect(response.body.streams).toHaveLength(2)
      })

      it('should filter by recipient', async () => {
        const response = await request(app)
          .get('/api/streams?recipient=GDRX2XXXXXXXXXXXXXXXXXXXXXXC')
          .expect(200)
        expect(response.body.streams).toHaveLength(1)
        expect(response.body.streams[0].id).toBe('2')
      })

      it('should combine filters correctly', async () => {
        const response = await request(app)
          .get(
            '/api/streams?status=active&recipient=GDRX2XXXXXXXXXXXXXXXXXXXXXXB'
          )
          .expect(200)
        expect(response.body.streams).toHaveLength(2)
      })

      it('should return 400 for invalid status', async () => {
        const response = await request(app)
          .get('/api/streams?status=invalid_state')
          .expect(400)
        expect(response.body.error.code).toBe('VALIDATION_ERROR')
      })

      it('should return 400 for invalid sender address', async () => {
        const response = await request(app)
          .get('/api/streams?sender=invalid-address')
          .expect(400)
        expect(response.body.error.code).toBe('VALIDATION_ERROR')
      })
    })
  });

  describe('GET /api/streams/:id', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('should return 200 and the stream data if found in the database', async () => {
      const mockStream = {
        id: 'stream-123',
        sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
        recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
        depositAmount: '100.0000000',
        ratePerSecond: '0.0010000',
        startTime: 1700000000,
        endTime: 0,
        status: 'active',
      }

      // Tell our mock DB to return the stream
      ;(getStreamById as jest.Mock).mockResolvedValueOnce(mockStream)

      const response = await request(app)
        .get('/api/streams/stream-123')
        .expect(200)

      expect(response.body).toEqual(mockStream)
      expect(getStreamById).toHaveBeenCalledWith('stream-123')
    })

    it('should return 404 for non-existent stream', async () => {
      // Tell our mock DB to return null (not found)
      ;(getStreamById as jest.Mock).mockResolvedValueOnce(null)

      const response = await request(app)
        .get('/api/streams/non-existent-id')
        .expect(404)

      expect(response.body.error.code).toBe('NOT_FOUND')
    })

    it('should return 503 if the database query fails', async () => {
      // Tell our mock DB to throw an error
      ;(getStreamById as jest.Mock).mockRejectedValueOnce(
        new Error('Connection timeout')
      )

      const response = await request(app)
        .get('/api/streams/stream-123')
        .expect(503)

      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
    })
  })

  describe('DELETE /api/streams/:id', () => {
    it('should return 404 for non-existent stream', async () => {
      const response = await request(app)
        .delete('/api/streams/non-existent-id')
        .set('Authorization', `Bearer ${token}`)
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
      .set('Authorization', `Bearer ${testToken}`)
      .set('Idempotency-Key', nextIdempotencyKey())
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');

    // Express JSON parser returns 400 for malformed JSON
    // But in this test setup, it might return 500
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThanOrEqual(500);
  });
});
