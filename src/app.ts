/**
 * Express application factory.
 *
 * Separated from the server bootstrap in index.ts so that tests
 * can import the app without binding to a port.
 */

import express from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { privacyRouter } from './routes/privacy.js';
import { privacyHeaders, requestLogger, safeErrorHandler } from './middleware/pii.js';

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());
  app.use(privacyHeaders);
  app.use(requestLogger);

  app.use('/health', healthRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/privacy', privacyRouter);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  app.use(safeErrorHandler);

  return app;
}
