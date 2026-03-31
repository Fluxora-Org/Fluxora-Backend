import { Router } from 'express';
import type { Request, Response } from 'express';
import type { RateLimiter } from '../middleware/rateLimiter.js';

export function createRateLimitsRouter(limiter: RateLimiter) {
  const rateLimitsRouter = Router();

  rateLimitsRouter.get('/', (req: Request, res: Response) => {
    const { identifier, identifierType } = limiter.extractClientIdentifier(req);
    const status = limiter.getStatus(identifier, identifierType);

    res.setHeader('X-RateLimit-Limit', String(status.limit));
    res.setHeader('X-RateLimit-Remaining', String(status.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(new Date(status.resetsAt).getTime() / 1000)));

    res.json(status);
  });

  return rateLimitsRouter;
}
