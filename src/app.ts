import express from 'express';
import type { Request, Response } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';

export const app = express();

app.use(express.json());
// Correlation ID must be first so all subsequent middleware and routes have req.correlationId.
app.use(correlationIdMiddleware);
app.use(requestLoggerMiddleware);

app.use('/health', healthRouter);
app.use('/api/streams', streamsRouter);

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Fluxora API',
    version: '0.1.0',
    docs: 'Programmable treasury streaming on Stellar.',
  });
});
