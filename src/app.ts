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
  /** Override payload limit in bytes (default 256 KiB). */
  payloadLimitBytes?: number;
}

export function createApp(options: AppOptions = {}): express.Express {
  const application = express();

  // Security headers — applied before any route handler
  application.use((_req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0'); // modern browsers ignore this; CSP is the right control
    next();
  });

  const payloadLimit = options.payloadLimitBytes ?? 256 * 1024;
  application.use(express.json({ limit: payloadLimit }));
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
