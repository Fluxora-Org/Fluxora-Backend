import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdminAuth } from '../../middleware/adminAuth.js';
import { successResponse, errorResponse } from '../../utils/response.js';
import { formatZodIssues } from '../../validation/schemas.js';
import {
  createOverride,
  deleteOverride,
  listOverrides,
  getOverride as getOverrideByIdentity,
} from '../../services/tenantRateLimitOverride.service.js';
import { ApiError } from '../../errors.js';

const createOverrideSchema = z.object({
  keyId: z.string().min(1, 'keyId is required'),
  maxRequests: z.number().int().positive('maxRequests must be a positive integer'),
  windowMs: z.number().int().min(1000, 'windowMs must be at least 1000'),
  expiresAt: z.string().datetime().optional(),
});

export const tenantRateLimitOverridesRouter = Router();

function getAdminIdentity(req: Request): string {
  const header = req.headers.authorization;
  if (!header) return 'unknown';
  const parts = header.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    return `admin:${parts[1]!.slice(0, 8)}`;
  }
  return 'unknown';
}

tenantRateLimitOverridesRouter.post('/', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = req.correlationId;

  const parseResult = createOverrideSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json(
      errorResponse('VALIDATION_ERROR', 'Request validation failed', formatZodIssues(parseResult.error.issues), requestId),
    );
    return;
  }

  const { keyId, maxRequests, windowMs, expiresAt } = parseResult.data;

  const existing = await getOverrideByIdentity(keyId);
  if (existing) {
    res.status(409).json(
      errorResponse('CONFLICT', `An override for keyId '${keyId}' already exists.`, undefined, requestId),
    );
    return;
  }

  const createdBy = getAdminIdentity(req);
  const override = await createOverride({ keyId, maxRequests, windowMs, expiresAt }, createdBy);
  res.status(201).json(successResponse(override, requestId));
});

tenantRateLimitOverridesRouter.get('/', requireAdminAuth, async (_req: Request, res: Response) => {
  const requestId = _req.correlationId;
  const overrides = await listOverrides();
  res.json(successResponse(overrides, requestId));
});

tenantRateLimitOverridesRouter.delete('/:id', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = req.correlationId;
  const { id } = req.params;

  try {
    await deleteOverride(id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      res.status(404).json(
        errorResponse('NOT_FOUND', err.message, undefined, requestId),
      );
      return;
    }
    throw err;
  }
});
