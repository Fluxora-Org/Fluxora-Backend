import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateToken } from '../lib/auth.js';
import { validationError, asyncHandler } from '../middleware/errorHandler.js';
import { info } from '../utils/logger.js';

export const authRouter = Router();

// Schema for session creation
const SessionRequestSchema = z.object({
  address: z.string().min(1, 'Stellar address is required'),
  role: z.enum(['operator', 'viewer']).optional().default('viewer'),
});

/**
 * @openapi
 * /api/auth/session:
 *   post:
 *     summary: Create a new session (get JWT)
 *     description: |
 *       Issues a JWT for a dashboard client. 
 *       In this iteration, any valid Stellar address can obtain a session.
 *     tags:
 *       - auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - address
 *             properties:
 *               address:
 *                 type: string
 *                 description: Stellar account address
 *               role:
 *                 type: string
 *                 enum: [operator, viewer]
 *                 default: viewer
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
 */
authRouter.post(
  '/session',
  asyncHandler(async (req: Request, res: Response) => {
    const result = SessionRequestSchema.safeParse(req.body);
    const requestId = (req as any).id || (req as any).correlationId;

    if (!result.success) {
      throw validationError('Invalid session request', result.error.format());
    }

    const { address, role } = result.data;
    const token = generateToken({ address, role: role as 'operator' | 'viewer' });

    info('Session created', { address, role, requestId });

    res.json({
      token,
      user: { address, role },
    });
  })
);
