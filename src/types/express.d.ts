import 'express';
import type { UserPayload } from '../lib/auth.js';

declare global {
  // The public `express.Request` extends `Express.Request`, so augmenting the
  // `Express` global namespace is what reaches `req.user` / `req.correlationId`
  // call-sites without breaking existing typings.

  namespace Express {
    interface Request {
      /** Attached by auth middleware when a valid JWT is present. */
      user?: UserPayload;
      /** Attached by correlationId middleware. */
      correlationId?: string;
      /** Attached by requestIdMiddleware (errors.ts). */
      id?: string;
      /** Attached by stream scoping middleware for repository filters. */
      callerAddress?: string;
      /** Attached by apiVersion middleware based on the Accept-Version header. */
      apiVersion?: string;
    }
  }
}

// This file must be a module for `declare global` to take effect.
export {};
