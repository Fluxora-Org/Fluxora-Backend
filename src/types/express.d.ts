/**
 * Augments the Express Request type to include `correlationId`.
 * Populated by `correlationIdMiddleware` before any route handler runs.
 *
 * Also re-opens the NextFunction interface to restore its call signature,
 * which TypeScript 5.x drops when the interface is declared as an empty
 * extension of core.NextFunction.
 */
import { UserPayload } from '../lib/auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
    user?: UserPayload;
  }
}

declare module 'express' {
  // Restore call signatures lost by the empty interface extension in @types/express
  interface NextFunction {
    (err?: unknown): void;
    (deferToNext: 'router'): void;
    (deferToNext: 'route'): void;
  }

  // Restore Response methods that are missing from the re-exported interface
  interface Response<
    ResBody = unknown,
    Locals extends Record<string, unknown> = Record<string, unknown>,
  > extends core.Response<ResBody, Locals> {}
}
