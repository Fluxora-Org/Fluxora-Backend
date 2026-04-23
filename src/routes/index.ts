import { Router } from 'express';
import type { Request, Response } from 'express';
import { healthRouter } from './health.js';
import { registry } from '../metrics.js';

export const rootRouter = Router();

rootRouter.use('/health', healthRouter);

rootRouter.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
