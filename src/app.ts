import express from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

export interface AppOptions {
  includeTestRoutes?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const app = express();

  app.use(correlationIdMiddleware);
  app.use(express.json({ limit: '1mb', strict: false }));
  app.use(requestLoggerMiddleware);

  // Versioning header middleware
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-API-Version', 'v1');
    next();
  });

  // Base API Versioning: /v1 namespace
  const v1Router = express.Router();
  
  // Public: Anyone can check health (trust boundary: read-only)
  v1Router.use('/health', healthRouter);
  
  // Auth Partners: Managed streams
  v1Router.use('/streams', streamsRouter);

  app.use('/v1', v1Router);
  // Alias /api/streams to /v1/streams for backward compatibility (deprecated)
  app.use('/api/streams', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</v1/streams>; rel="deprecation"');
    next();
  }, streamsRouter);

  // Root endpoint: API discovery and deprecation policy
  app.get('/', (_req: express.Request, res: express.Response) => {
    res.json({
      name: 'Fluxora API',
      version: '1.0.0',
      description: 'Programmable treasury streaming on Stellar.',
      current_version: '/v1',
      deprecation_policy: {
        policy: 'vN is supported until vN+2 is released or 12 months, whichever is later.',
        contact: 'operator@fluxora.org'
      },
      documentation: {
        v1: '/v1',
        health: '/v1/health',
      },
      decimalPolicy: {
        description: 'All amount fields are serialized as decimal strings',
        fields: ['depositAmount', 'ratePerSecond'],
        format: '^[+-]?\\d+(\\.\\d+)?$',
      },
    });
  });

  if (options.includeTestRoutes) {
    app.get('/__test/error', () => {
      throw new Error('Test error');
    });
  }

  // 404 handler
  app.use((_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next(notFound('Resource'));
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

// Default instance for simple imports
export const app = createApp();
