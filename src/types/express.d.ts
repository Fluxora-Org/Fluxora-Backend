import 'express';
import type { UserPayload } from '../lib/auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Attached by auth middleware when a valid JWT is present. */
    user?: UserPayload;
    /** Attached by correlationId middleware. */
    correlationId?: string;
    /** Attached by requestIdMiddleware (errors.ts). */
    id?: string;
  }
}
