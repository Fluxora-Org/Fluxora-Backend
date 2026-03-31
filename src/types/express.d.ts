import { UserPayload } from '../lib/auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
      correlationId?: string;
    }
  }
}
