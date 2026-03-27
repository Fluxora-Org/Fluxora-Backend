import express from 'express';
import type { Request, Response } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import {
  requestIdMiddleware,
  notFoundHandler,
  errorHandler,
} from './errors.js';

export interface AppOptions {
  /** When true, mounts a /__test/error route that throws unconditionally. */
  includeTestRoutes?: boolean;
}

export function createApp(options: AppOptions = {}): express.Express {
  const application = express();

  application.use(express.json({ limit: '256kb' }));
  application.use(requestIdMiddleware);
  application.use(correlationIdMiddleware);
  application.use(requestLoggerMiddleware);

  application.use('/health', healthRouter);
  application.use('/api/streams', createRateLimiter({ max: 100, windowSeconds: 60 }), idempotencyMiddleware, streamsRouter);

  application.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  if (options.includeTestRoutes === true) {
    application.get('/__test/error', () => {
      throw new Error('forced test error');
    });
  }

  application.use(notFoundHandler);
  application.use(errorHandler);

  return application;
}

export const app = createApp();
