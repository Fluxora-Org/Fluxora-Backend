import express from 'express';
import type { Request, Response } from 'express';
import { registry } from '../metrics.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { syncWebhookMetrics } from '../metrics/businessMetrics.js';
import { webhookDeliveryStore } from '../webhooks/storeFactory.js';
import { warn } from '../lib/logger.js';
import { errorResponse } from '../utils/response.js';

export const metricsRouter = express.Router();

/**
 * GET /metrics
 *
 * Prometheus scrape endpoint.
 *
 * Returns Prometheus-format metrics including:
 * - http_requests_total: Counter of HTTP requests by method, route, status_code
 * - http_request_duration_seconds: Histogram of request latency
 * - fluxora_webhook_dlq_items: Gauge of webhook dead-letter queue depth
 * - fluxora_webhook_outbox_pending_items: Gauge of webhook outbox backlog
 * - Default Node.js runtime metrics (process info, GC, memory, etc.)
 *
 * Content-Type: text/plain; version=0.0.4
 *
 * ## Access Control & Security
 * - Authorization: Protected by Bearer token authentication via requireAdminAuth.
 *   Prometheus scrape jobs must provide: `Authorization: Bearer <ADMIN_API_KEY>`
 *   or a signed JWT token carrying the `admin` or `data-protection-officer` role.
 * - Interface Binding: In production environments, this endpoint must not be exposed
 *   to public external traffic. Ingress controllers and reverse proxies must either
 *   restrict /metrics to internal monitoring VPCs / private interfaces or bind to
 *   internal loopback / management network.
 * - Refusal & Logging: Any unauthenticated or unauthorized request (missing/invalid
 *   scheme, wrong token, or unconfigured ADMIN_API_KEY) is rejected with 401, 403,
 *   or 503 and logged as a structured warning with request metadata without leaking
 *   credential material.
 * - Cardinality: All exposed metrics use strictly bounded label sets. No high-cardinality
 *   or per-user data (e.g. user IDs, wallet addresses, emails, raw tokens) is ever
 *   emitted in metric labels.
 */
metricsRouter.get('/', requireAdminAuth, async (req: Request, res: Response) => {
   try {
     // Sync webhook metrics from store
     syncWebhookMetrics(webhookDeliveryStore);

     res.set('Content-Type', registry.contentType);
     const metrics = await registry.metrics();
     res.send(metrics);
   } catch (err) {
     warn('Failed to generate metrics', {
       error: err instanceof Error ? err.message : String(err),
     });
    res.status(500).json(errorResponse('INTERNAL_ERROR', 'Failed to generate metrics', undefined, req.correlationId));
   }
 });
