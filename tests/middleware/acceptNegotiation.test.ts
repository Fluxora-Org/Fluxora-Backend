import express from 'express';
import request from 'supertest';
import { requireJsonAccept } from '../../src/middleware/acceptNegotiation.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

describe('requireJsonAccept middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(requireJsonAccept);
    app.get('/read', (_req, res) => res.json({ ok: true }));
    app.post('/read', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
  });

  describe('satisfiable representations', () => {
    it('passes through when no Accept header is sent', async () => {
      await request(app)
        .get('/read')
        .expect(200)
        .expect((res) => expect(res.body.ok).toBe(true));
    });

    it('passes through for the `*/*` wildcard', async () => {
      await request(app).get('/read').set('Accept', '*/*').expect(200);
    });

    it('passes through for the `application/*` wildcard', async () => {
      await request(app).get('/read').set('Accept', 'application/*').expect(200);
    });

    it('passes through for an exact `application/json` match', async () => {
      await request(app).get('/read').set('Accept', 'application/json').expect(200);
    });

    it('passes through for `application/json` with parameters', async () => {
      await request(app)
        .get('/read')
        .set('Accept', 'application/json; charset=utf-8')
        .expect(200);
    });

    it('passes through for vendor +json media types', async () => {
      await request(app).get('/read').set('Accept', 'application/vnd.api+json').expect(200);
    });

    it('treats media types case-insensitively', async () => {
      await request(app).get('/read').set('Accept', 'APPLICATION/JSON').expect(200);
    });

    it('passes through when the Accept header is unparseable', async () => {
      await request(app).get('/read').set('Accept', ',,,').expect(200);
    });
  });

  describe('unacceptable representations', () => {
    it('rejects `application/xml` with 406', async () => {
      await request(app).get('/read').set('Accept', 'application/xml').expect(406);
    });

    it('rejects `text/html` with 406', async () => {
      await request(app).get('/read').set('Accept', 'text/html').expect(406);
    });

    it('rejects an unsupported representation on write methods too', async () => {
      await request(app).post('/read').set('Accept', 'application/xml').expect(406);
    });

    it('returns the standard error envelope on 406', async () => {
      const res = await request(app).get('/read').set('Accept', 'application/xml');

      expect(res.status).toBe(406);
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'NOT_ACCEPTABLE',
          message: 'This endpoint only produces application/json responses',
        },
      });
    });
  });

  describe('quality values', () => {
    it('passes through when JSON is listed at a lower quality', async () => {
      await request(app)
        .get('/read')
        .set('Accept', 'application/xml, application/json;q=0.9')
        .expect(200);
    });

    it('passes through when JSON is listed without a quality value', async () => {
      await request(app).get('/read').set('Accept', 'application/xml;q=1.0, application/json').expect(200);
    });

    it('passes through for a low-quality JSON entry as long as q > 0', async () => {
      await request(app)
        .get('/read')
        .set('Accept', 'application/xml;q=1.0, application/json;q=0.1')
        .expect(200);
    });

    it('ignores a media range disallowed with q=0', async () => {
      await request(app).get('/read').set('Accept', 'application/xml;q=0, application/json').expect(200);
    });

    it('rejects when `application/json` itself is disallowed with q=0', async () => {
      await request(app).get('/read').set('Accept', 'application/json;q=0').expect(406);
    });

    it('rejects when the wildcard is disallowed with q=0', async () => {
      await request(app).get('/read').set('Accept', '*/*;q=0').expect(406);
    });

    it('rejects when every listed representation is disallowed with q=0', async () => {
      await request(app)
        .get('/read')
        .set('Accept', 'application/xml;q=0, text/html;q=0')
        .expect(406);
    });
  });

  describe('integration with createApp', () => {
    it('GET /api/streams with an unsupported Accept returns 406', async () => {
      const { createApp } = await import('../../src/app.js');
      const testApp = createApp({ includeTestRoutes: false });
      await request(testApp).get('/api/streams').set('Accept', 'application/xml').expect(406);
    });
  });
});
