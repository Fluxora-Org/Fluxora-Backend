import express from 'express';
import request from 'supertest';
import { requireJsonContentType } from '../../src/middleware/contentType.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

describe('requireJsonContentType middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(requireJsonContentType);
    app.use(express.json());
    app.post('/write', (req, res) => res.status(201).json({ ok: true }));
    app.put('/write', (req, res) => res.status(200).json({ ok: true }));
    app.patch('/write', (req, res) => res.status(200).json({ ok: true }));
    app.get('/read', (_req, res) => res.json({ ok: true }));
    app.delete('/read', (_req, res) => res.status(204).send());
    app.use(errorHandler);
  });

  describe('POST /write', () => {
    it('accepts application/json', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' })
        .expect(201)
        .expect((res) => expect(res.body.ok).toBe(true));
    });

    it('accepts application/json with charset', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send({ foo: 'bar' })
        .expect(201);
    });

    it('accepts vendor +json media types', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'application/vnd.api+json')
        .send({ data: 'test' })
        .expect(201);
    });

    it('rejects text/plain with 415', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'text/plain')
        .send('hello')
        .expect(415);
    });

    it('rejects multipart/form-data with 415', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'multipart/form-data')
        .expect(415);
    });

    it('rejects application/xml with 415', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'application/xml')
        .send('<root/>')
        .expect(415);
    });

    it('rejects with standard error envelope on 415', async () => {
      const res = await request(app)
        .post('/write')
        .set('Content-Type', 'text/plain')
        .send('hello');

      expect(res.status).toBe(415);
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Content-Type must be application/json',
        },
      });
    });

    it('passes through when Content-Type header is missing', async () => {
      await request(app)
        .post('/write')
        .send({ foo: 'bar' })
        .expect(201);
    });
  });

  describe('PUT /write', () => {
    it('rejects text/plain with 415', async () => {
      await request(app)
        .put('/write')
        .set('Content-Type', 'text/plain')
        .send('hello')
        .expect(415);
    });

    it('accepts application/json', async () => {
      await request(app)
        .put('/write')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' })
        .expect(200);
    });
  });

  describe('PATCH /write', () => {
    it('rejects text/plain with 415', async () => {
      await request(app)
        .patch('/write')
        .set('Content-Type', 'text/plain')
        .send('hello')
        .expect(415);
    });

    it('accepts application/json', async () => {
      await request(app)
        .patch('/write')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' })
        .expect(200);
    });
  });

  describe('read methods are unaffected', () => {
    it('GET passes through with text/plain', async () => {
      await request(app)
        .get('/read')
        .set('Content-Type', 'text/plain')
        .expect(200);
    });

    it('DELETE passes through with text/plain', async () => {
      await request(app)
        .delete('/read')
        .set('Content-Type', 'text/plain')
        .expect(204);
    });
  });

  describe('integration with createApp', () => {
    it('POST /api/streams with text/plain returns 415', async () => {
      const { createApp } = await import('../../src/app.js');
      const testApp = createApp({ includeTestRoutes: false });
      await request(testApp)
        .post('/api/streams')
        .set('Content-Type', 'text/plain')
        .send('not json')
        .expect(415);
    });

    it('PUT /api/admin/pause with text/plain returns 415', async () => {
      const { createApp } = await import('../../src/app.js');
      const testApp = createApp({ includeTestRoutes: false });
      await request(testApp)
        .put('/api/admin/pause')
        .set('Content-Type', 'text/plain')
        .send('not json')
        .expect(415);
    });

    it('internal routes are not affected by requireJsonContentType', async () => {
      const { createApp } = await import('../../src/app.js');
      const testApp = createApp({ includeTestRoutes: false });
      await request(testApp)
        .post('/internal/webhooks/receive')
        .set('Content-Type', 'text/plain')
        .send('not json')
        .expect((res) => {
          expect(res.status).not.toBe(415);
        });
    });
  });

  describe('edge cases', () => {
    it('handles uppercase Content-Type', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', 'APPLICATION/JSON')
        .send({ foo: 'bar' })
        .expect(201);
    });

    it('handles charset with extra whitespace', async () => {
      await request(app)
        .post('/write')
        .set('Content-Type', '  application/json  ;  charset=utf-8  ')
        .send({ foo: 'bar' })
        .expect(201);
    });
  });
});
