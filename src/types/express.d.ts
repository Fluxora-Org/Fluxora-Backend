/**
 * Augments the Express Request type to include `correlationId`.
 * Populated by `correlationIdMiddleware` before any route handler runs.
 */
declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}
