import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { privacyRouter } from './routes/privacy.js';
import { indexerRouter } from './routes/indexer.js';
import { privacyHeaders, requestLogger, safeErrorHandler } from './middleware/pii.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { corsAllowlistMiddleware } from './middleware/cors.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { isShuttingDown } from './shutdown.js';

/**
 * Express application factory.
 *
 * Separated from the server bootstrap in index.ts so that tests
 * can import the app without binding to a port.
 */
export function createApp(): express.Express {
  const app = express();

  // Basic middleware
  app.use(express.json({ limit: '256kb' }));

  // Security and observability middleware
  // Correlation ID must be first so all subsequent middleware and routes have req.correlationId.
  app.use(correlationIdMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(privacyHeaders);

  // Correlation ID middleware (required for tracing)
  app.use(correlationIdMiddleware);

  // Distributed tracing middleware (optional, enabled via env config)
  // The tracer is initialized globally in index.ts based on environment variables
  // This is safe to call even if config hasn't been initialized (will just use defaults)
  try {
    const config = getConfig();
    if (config && config.tracingEnabled) {
      app.use(tracingMiddleware({
        enabled: true,
        sampleRate: config.tracingSampleRate ?? 1.0,
      }));
    }
  } catch (err) {
    // Configuration not initialized (may be in tests), skip tracing middleware
    // This is safe and the app will continue to function normally
  }

  app.use(requestLogger);
  app.use(requestLoggerMiddleware);

  // During shutdown, tell clients to close the connection after this response
  // so keep-alive connections are not reused and the server can drain quickly.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (isShuttingDown()) {
      res.setHeader('Connection', 'close');
    }
    next();
  });

  // Routes
  app.use('/health', healthRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/privacy', privacyRouter);
  app.use('/internal/indexer', indexerRouter);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
      },
    });
  });

  // Error handling
  app.use(safeErrorHandler);

  return app;
}

export const app = createApp();
