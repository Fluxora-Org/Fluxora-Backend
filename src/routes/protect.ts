import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

/**
 * Explicit list of deliberately public paths which do not receive automatic
 * authentication wiring. Any non-public route should be registered through
 * `protectRouter` so `authenticate` always runs before route handlers.
 */
export const PUBLIC_ROUTE_PATHS = new Set<string>([
  '/api/auth',
  '/api/streams',
  '/health',
  '/docs',
  '/metrics',
]);

/**
 * Wrap a router so that `authenticate` runs for every request entering it.
 * Use this for all route groups that require authentication decisions to be
 * available to downstream handlers.
 */
export function protectRouter(router: Router): Router {
  const r = Router();
  r.use(authenticate);
  r.use(router);
  return r;
}
