import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { indexerRouter } from './routes/indexer.js';
import { jobsRouter } from './routes/jobs.js';
import { privacyHeaders, requestLogger, safeErrorHandler } from './middleware/pii.js';
import { auditRouter } from './routes/audit.js';
import { dlqRouter } from './routes/dlq.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { corsAllowlistMiddleware } from './middleware/cors.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { isShuttingDown } from './shutdown.js';

export interface AppOptions {
  /** When true, mounts a /__test/error route that throws unconditionally. */
  includeTestRoutes?: boolean;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  // Correlation ID must be first so all subsequent middleware/routes have req.correlationId.
  app.use(correlationIdMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(privacyHeaders);

  // Distributed tracing middleware (optional, enabled via env config)
  // The tracer is initialized globally in index.ts based on environment variables
  // This is safe to call even if config hasn't been initialized (will just use defaults)
  try {
    // Note: getConfig and tracingMiddleware would be imported if tracing is enabled
    // Commented out for now as these may not be available in all environments
    // const config = getConfig();
    // if (config && config.tracingEnabled) {
    //   app.use(tracingMiddleware({
    //     enabled: true,
    //     sampleRate: config.tracingSampleRate ?? 1.0,
    //   }));
    // }
  } catch (_err) {
    // Configuration not initialized (may be in tests), skip tracing middleware
    // This is safe and the app will continue to function normally
  }

  app.use(requestLogger);
  app.use(requestLoggerMiddleware);

  // During shutdown, tell clients to close the connection so keep-alive
  // connections are not reused and the server can drain quickly.
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
  app.use('/api/streams', streamsRouter);
  app.use('/internal/indexer', indexerRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/admin/dlq', dlqRouter);

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found' },
    });
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
