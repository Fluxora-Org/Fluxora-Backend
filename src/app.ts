import express, { type Express } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { createRateLimitsRouter } from './routes/rateLimits.js';
import { createRateLimiter } from './middleware/rateLimiter.js';

export function createApp(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Express {
  const app = express();

  app.use(express.json());

  const limiter = createRateLimiter(env);
  app.use(limiter);

  app.use('/health', healthRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/rate-limits', createRateLimitsRouter(limiter));

  app.get('/', (_req, res) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  return app;
}
