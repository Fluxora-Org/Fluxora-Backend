import express from 'express';
import type { Request, Response } from 'express';
import { registry } from '../metrics.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

export const metricsRouter = express.Router();

/**
 * GET /metrics
 *
 * Returns Prometheus-format metrics including:
 * - http_requests_total: Counter of HTTP requests by method, route, status_code
 * - http_request_duration_seconds: Histogram of request latency
 * - fluxora_webhook_dlq_items / fluxora_webhook_outbox_pending_items
 *   aggregate webhook backlog gauges
 * - Default Node.js metrics (process info, GC, memory, etc.)
 *
 * Content-Type: text/plain; version=0.0.4
 *
 * Protected by Bearer token auth (ADMIN_API_KEY). Prometheus scrape jobs must
 * include: Authorization: Bearer <ADMIN_API_KEY>
 */
metricsRouter.get('/', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', registry.contentType);
    const metrics = await registry.metrics();
    res.send(metrics);
  } catch {
    res.status(500).send('Failed to generate metrics');
  }
});