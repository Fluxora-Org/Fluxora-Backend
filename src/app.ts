import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { indexerRouter } from './routes/indexer.js';
import { auditRouter } from './routes/audit.js';
import { adminRouter } from './routes/admin.js';
import { dlqRouter } from './routes/dlq.js';
import { authRouter } from './routes/auth.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { corsAllowlistMiddleware } from './middleware/cors.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { bodySizeLimitMiddleware, requestTimeoutMiddleware, BODY_LIMIT_BYTES } from './middleware/requestProtection.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import { isShuttingDown } from './shutdown.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { createRateLimitsRouter } from './routes/rateLimits.js';
import { getRateLimitConfig } from './config/rateLimits.js';
import { successResponse, errorResponse } from './utils/response.js';

export interface AppOptions {
  /** When true, mounts a /__test/error and /__test/timeout route. */
  includeTestRoutes?: boolean;
  /** Environment variables used to seed the rate-limiter (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Socket-level request timeout in ms (defaults to 30000). */
  requestTimeoutMs?: number;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const rateLimiter = createRateLimiter(env);

  app.use(bodySizeLimitMiddleware);
  app.use(express.json({ limit: BODY_LIMIT_BYTES }));
  // Correlation ID must be first so all subsequent middleware/routes have req.correlationId.
  app.use(correlationIdMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(httpMetrics);
  app.use(rateLimiter);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (isShuttingDown()) {
      res.setHeader('Connection', 'close');
    }
    next();
  });

  if (options.includeTestRoutes) {
    app.get('/__test/error', () => {
      throw new Error('Intentional test error');
    });
  }

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/internal/indexer', indexerRouter);
  app.use('/api/audit', auditRouter);
  app.use('/admin/dlq', dlqRouter);
  app.use('/api/rate-limits', createRateLimitsRouter(env));

  app.get('/', (_req: Request, res: Response) => {
    res.json(successResponse({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    }));
  });

  app.use((req: Request, res: Response) => {
    const requestId = (req as any).id as string | undefined;
    res.status(404).json(
      errorResponse('NOT_FOUND', 'The requested resource was not found', undefined, requestId),
    );
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
