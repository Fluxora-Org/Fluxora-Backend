import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateToken } from '../lib/auth.js';
import { validationError, unauthorized, asyncHandler, forbidden } from '../middleware/errorHandler.js';
import { info } from '../utils/logger.js';
import { getConfig } from '../config/env.js';
import { verifyIdToken } from '../services/oidcProvider.js';
import { revoke } from '../redis/jwtRevocationStore.js';
import { Permission, requirePermission } from '../middleware/auth.js';

export const authRouter = Router();

// Schema for session creation supporting OIDC token exchange and shared-secret fallback
const SessionRequestSchema = z.object({
  address: z.string().optional(),
  role: z.enum(['operator', 'viewer']).optional().default('viewer'),
  idToken: z.string().optional(),
}).refine(data => {
  // If idToken is not provided, address is required.
  if (!data.idToken && (!data.address || data.address.trim() === '')) {
    return false;
  }
  return true;
}, {
  message: 'Stellar address is required when idToken is not provided',
  path: ['address'],
});

/**
 * @openapi
 * /api/auth/session:
 *   post:
 *     summary: Create a new session (get JWT)
 *     description: |
 *       Issues a JWT for a dashboard client.
 *       If OIDC is configured and an ID token is provided, uses OIDC exchange.
 *       Otherwise, falls back to the static shared-secret path.
 *     tags:
 *       - auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *                 description: Stellar account address
 *               role:
 *                 type: string
 *                 enum: [operator, viewer]
 *                 default: viewer
 *               idToken:
 *                 type: string
 *                 description: External OIDC ID token
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 */
authRouter.post(
  '/session',
  asyncHandler(async (req: Request, res: Response) => {
    const result = SessionRequestSchema.safeParse(req.body);
    const requestId = req.id ?? req.correlationId;

    if (!result.success) {
      throw validationError('Invalid session request', result.error.format());
    }

    const { address, role, idToken } = result.data;
    const config = getConfig();

    let targetAddress = address;
    let targetRole = role;

    if (idToken) {
      if (!config.oidcIssuerUrl) {
        throw validationError('OIDC authentication is not configured on this server');
      }

      try {
        const verified = await verifyIdToken(idToken);
        if (!targetAddress) {
          targetAddress = verified.address;
        }
        if (!req.body.role) {
          targetRole = verified.role;
        }
      } catch (err) {
        throw unauthorized(`OIDC token validation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!targetAddress) {
      throw validationError('Stellar address is required');
    }

    const token = generateToken({ address: targetAddress, role: targetRole as 'operator' | 'viewer' });

    info('Session created', { address: targetAddress, role: targetRole, requestId, authMethod: idToken ? 'oidc' : 'shared-secret' });

    res.json({
      token,
      user: { address: targetAddress, role: targetRole },
    });
  })
);

// ── Revocation endpoint ──

const RevokeRequestSchema = z.object({
  jti: z.string().min(1, 'jti is required'),
  ttl: z.coerce.number().int().positive().optional(),
});

/**
 * @openapi
 * /api/auth/revoke:
 *   post:
 *     summary: Revoke a JWT by its jti claim
 *     description: |
 *       Admin-only endpoint to immediately invalidate a JWT before its natural expiry.
 *       Adds the jti to the Redis-backed revocation list with a TTL.
 *     tags:
 *       - auth
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               jti:
 *                 type: string
 *                 description: JWT ID (jti) claim to revoke
 *               ttl:
 *                 type: integer
 *                 description: Time-to-live in seconds (optional, defaults to 7 days)
 *     responses:
 *       200:
 *         description: Token revoked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 jti:
 *                   type: string
 *                 ttl:
 *                   type: integer
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden — admin permission required
 */
authRouter.post(
  '/revoke',
  requirePermission(Permission.ADMIN_PAUSE), // Admin-only: any admin permission suffices
  asyncHandler(async (req: Request, res: Response) => {
    const result = RevokeRequestSchema.safeParse(req.body);
    const requestId = req.id ?? req.correlationId;

    if (!result.success) {
      throw validationError('Invalid revocation request', result.error.format());
    }

    const { jti, ttl } = result.data;

    await revoke(jti, ttl);

    info('JWT revoked via admin endpoint', { jti, ttlSeconds: ttl, revokedBy: (req.user as any)?.address, requestId });

    res.json({
      success: true,
      jti,
      ttl: ttl ?? null,
    });
  })
);