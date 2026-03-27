import jwt from 'jsonwebtoken';
import { info, warn } from '../utils/logger.js';

const DEFAULT_JWT_SECRET = 'fluxora-dev-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_EXPIRES_IN = '24h';

if (JWT_SECRET === DEFAULT_JWT_SECRET && process.env.NODE_ENV === 'production') {
  warn('Using default JWT secret in production! This is insecure.');
}

export interface UserPayload {
  address: string;
  role: 'operator' | 'viewer';
}

/**
 * Generate a JWT for a user payload.
 */
export function generateToken(payload: UserPayload): string {
  info('Generating JWT', { address: payload.address });
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify a JWT and return the payload.
 * Throws if the token is invalid or expired.
 */
export function verifyToken(token: string): UserPayload {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as UserPayload;
    return payload;
  } catch (error) {
    warn('JWT verification failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
