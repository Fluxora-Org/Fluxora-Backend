import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { bodySizeLimitMiddleware, jsonDepthMiddleware, dynamicJsonParser } from './requestProtection.js';
import { requestRefusedTotal, deRegisterRequestProtectionMetrics } from '../metrics/requestProtectionMetrics.js';
import { registry } from '../metrics.js';

describe('Request Protection Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    deRegisterRequestProtectionMetrics();
    app = express();
  });

  afterEach(() => {
    deRegisterRequestProtectionMetrics();
  });

  describe('body size limit', () => {
    beforeEach(() => {
      app = express();
      app.use(bodySizeLimitMiddleware);
      app.use(dynamicJsonParser);
      app.post('/test', (req, res) => res.json(req.body));
      app.use(errorHandler);
    });

    it('rejects payloads larger than the configured limit via Content-Length', async () => {
      const largeBody = { data: 'a'.repeat(300) };
      await request(app)
        .post('/test')
        .set('Content-Length', '1000000')
        .send(largeBody)
        .expect(413);

      const metric = await registry.getSingleMetric('fluxora_request_refused_total');
      const metricValue = (metric as any).get();
      expect(metricValue).toBeDefined();
    });

    it('increments requestRefusedTotal with reason=body_too_large', async () => {
      const largeBody = { data: 'a'.repeat(300) };
      await request(app)
        .post('/test')
        .set('Content-Length', '1000000')
        .send(largeBody)
        .expect(413);

      const metric = await registry.getSingleMetric('fluxora_request_refused_total');
      const metricValue = (metric as any).get();
      const bodyTooLargeValue = metricValue.find((m: any) => m.values.reason === 'body_too_large');
      expect(bodyTooLargeValue).toBeDefined();
      expect(bodyTooLargeValue.value).toBe(1);
    });
  });

  describe('JSON depth validation', () => {
    beforeEach(() => {
      app = express();
      app.use(express.json({ limit: '10mb' }));
      app.use(jsonDepthMiddleware(2)); // Very low limit for testing
      app.post('/test', (req, res) => res.json(req.body));
      app.use(errorHandler);
    });

    it('rejects payloads with excessive nesting depth', async () => {
      const deepBody = { level1: { level2: { level3: 'data' } } };
      await request(app)
        .post('/test')
        .send(deepBody)
        .expect(400);
    });

    it('increments requestRefusedTotal with reason=json_depth_exceeded', async () => {
      const deepBody = { level1: { level2: { level3: 'data' } } };
      await request(app)
        .post('/test')
        .send(deepBody)
        .expect(400);

      const metric = await registry.getSingleMetric('fluxora_request_refused_total');
      const metricValue = (metric as any).get();
      const depthExceededValue = metricValue.find((m: any) => m.values.reason === 'json_depth_exceeded');
      expect(depthExceededValue).toBeDefined();
      expect(depthExceededValue.value).toBe(1);
    });
  });
});
