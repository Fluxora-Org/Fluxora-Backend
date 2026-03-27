import express from 'express';
import { ApiError, ApiErrorCode } from '../middleware/errorHandler.js';

export const healthRouter = express.Router();

/**
 * @openapi
 * /v1/health:
 *   get:
 *     summary: Basic health check
 *     description: Returns the current status of the service and timestamp.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 */
healthRouter.get('/', (req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    service: 'fluxora-backend',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /v1/health/ready - Readiness probe
 */
healthRouter.get('/ready', (req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /v1/health/live - Liveness probe
 */
healthRouter.get('/live', (req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Fallback for unsupported methods on health routes
 */
healthRouter.all('*', (req: express.Request, res: express.Response) => {
  throw new ApiError(
    ApiErrorCode.METHOD_NOT_ALLOWED,
    `Method ${req.method} not allowed on ${req.originalUrl}`,
    405
  );
});
