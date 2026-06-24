import jwt, { type SignOptions } from 'jsonwebtoken';
import { getConfig } from '../config/env.js';
import { warn } from '../utils/logger.js';

export interface UserPayload {
  address: string;
  role: string;
  permissions?: string[];
}

/**
 * Generates a signed JWT for testing or initial administrative access.
 *
 * `expiresIn` accepts the same forms that `jsonwebtoken` supports — either
 * a numeric seconds value or a duration string like "24h" / "7d".  The cast
 * here is needed because @types/jsonwebtoken narrows the string form to a
 * branded `StringValue` literal.
 */
export function generateToken(payload: UserPayload): string {
  const { jwtSecret, jwtExpiresIn } = getConfig();
  const options: SignOptions = {};
  if (jwtExpiresIn !== undefined && jwtExpiresIn !== '') {
    // `jsonwebtoken` brands the string form as `StringValue`; users pass plain
    // duration strings like "24h" / "7d" which are runtime-equivalent.
    options.expiresIn = jwtExpiresIn as NonNullable<SignOptions['expiresIn']>;
  }
  // Backfill a permissions claim for legacy callers that only set a role.
  // This keeps existing tests and callers working while encouraging
  // explicit permissions in production tokens.
  const derived = { ...payload } as UserPayload;
  if (!Array.isArray(derived.permissions)) {
    if (derived.role === 'operator') {
      derived.permissions = [
        'streams:read',
        'streams:write',
        'dlq:list',
        'dlq:read',
        'dlq:replay',
        'dlq:delete',
        'dlq:consumer:resume',
        'audit:read',
      ];
    } else {
      // viewer or unknown role -> minimal read-only permissions
      derived.permissions = ['streams:read'];
    }
  }

  return jwt.sign(derived, jwtSecret, options);
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
