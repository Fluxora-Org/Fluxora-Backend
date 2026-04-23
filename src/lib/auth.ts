import jwt from 'jsonwebtoken';
import { getConfig } from '../config/env.js';
import { warn } from '../utils/logger.js';

export interface UserPayload {
  address: string;
  role: string;
}

/**
 * Generates a signed JWT for testing or initial administrative access.
 */
export function generateToken(payload: UserPayload): string {
  const { jwtSecret, jwtExpiresIn } = getConfig();
  return jwt.sign(payload, jwtSecret, { expiresIn: jwtExpiresIn as string | number });
}

/**
 * Verifies a JWT and returns the decoded payload.
 */
export function verifyToken(token: string): UserPayload {
  const { jwtSecret } = getConfig();
  try {
    const payload = jwt.verify(token, jwtSecret) as UserPayload;
    return payload;
  } catch (error) {
    warn('JWT verification failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
