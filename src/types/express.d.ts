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
      /**
       * Request identifier. Used alongside `correlationId` for log correlation;
       * call sites read it as `req.id ?? req.correlationId`.
       */
      id?: string;
      /** Attached by correlationId middleware. */
      correlationId?: string;
      /** Attached by apiVersion middleware based on the Accept-Version header. */
      apiVersion?: string;
      /** Attached by enforceStreamScope middleware; the normalized caller address. */
      callerAddress?: string;
      /**
       * Attached by canaryRoutingMiddleware.
       * `true`  — this request falls within the canary traffic slice.
       * `false` — this request is on the stable traffic slice.
       * `undefined` — middleware has not yet run (e.g. very early in the stack).
       */
      isCanary?: boolean;
      /** Attached by authenticateApiKey middleware; the api_keys.id (cuid2). */
      keyId?: string;
      /** Attached by authLockoutMiddleware; the AuthAttemptStore instance for recording auth failures. */
      authAttemptStore?: import('../redis/authAttemptStore.js').AuthAttemptStore;
    }
  }
}

// This file must be a module for `declare global` to take effect.
export {};
