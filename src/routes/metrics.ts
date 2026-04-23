import express from 'express';
import type { Request, Response } from 'express';
import { registry } from '../metrics.js';

export const metricsRouter = express.Router();

/**
 * GET /metrics
 *
 * Returns Prometheus-format metrics including:
 * - http_requests_total: Counter of HTTP requests by method, route, status_code
 * - http_request_duration_seconds: Histogram of request latency
 * - Default Node.js metrics (process info, GC, memory, etc.)
 *
 * Content-Type: text/plain; version=0.0.4
 * This endpoint is typically scraped by Prometheus or similar monitoring systems.
 */
metricsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', registry.contentType);
    const metrics = await registry.metrics();
    res.send(metrics);
  } catch (err) {
    res.status(500).send('Failed to generate metrics');
  }
});
