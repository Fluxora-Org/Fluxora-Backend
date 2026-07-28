import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DuplicateEntryError, PoolExhaustedError } from '../../db/pool.js';
import { ApiError } from '../../errors.js';
import { logger } from '../../lib/logger.js';
import { requireAdminAuth } from '../../middleware/adminAuth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  createOverride,
  deleteOverride,
  listOverrides,
  getOverride as getOverrideByIdentity,
} from '../../services/tenantRateLimitOverride.service.js';
import { successResponse, errorResponse } from '../../utils/response.js';
import { formatZodIssues } from '../../validation/schemas.js';

const createOverrideSchema = z.object({
  keyId: z.string().min(1, 'keyId is required'),
  maxRequests: z.number().int().positive('maxRequests must be a positive integer'),
  windowMs: z.number().int().min(1000, 'windowMs must be at least 1000'),
  expiresAt: z.string().datetime().optional(),
});

const TEMPORARY_FAILURE_RETRY_AFTER_SECONDS = 1;

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

function isPoolExhaustedError(err: unknown): boolean {
  return err instanceof PoolExhaustedError
    || (err instanceof Error && err.name === 'PoolExhaustedError');
}

function isDuplicateEntryError(err: unknown): boolean {
  return err instanceof DuplicateEntryError
    || (err instanceof Error && err.name === 'DuplicateEntryError');
}

function respondToTemporaryFailure(
  err: unknown,
  operation: 'create' | 'list' | 'delete',
  requestId: string | undefined,
  res: Response,
): boolean {
  if (!isPoolExhaustedError(err)) return false;

  res.setHeader('Retry-After', String(TEMPORARY_FAILURE_RETRY_AFTER_SECONDS));
  logger.warn('Tenant rate-limit override operation temporarily unavailable', requestId, {
    operation,
    outcome: 'pool_exhausted',
    retryAfterSeconds: TEMPORARY_FAILURE_RETRY_AFTER_SECONDS,
  });
  res.status(503).json(
    errorResponse(
      'SERVICE_UNAVAILABLE',
      'Tenant rate-limit overrides are temporarily unavailable. Please retry shortly.',
      undefined,
      requestId,
    ),
  );
  return true;
}

/**
 * Keep the permission boundary attached to this router so it remains protected
 * if mounted independently. In production the parent admin router applies the
 * same guard; retaining this local guard is deliberate defense in depth.
 *
 * requireAdminAuth preserves the existing authorization contract:
 * - the configured static ADMIN_API_KEY is accepted;
 * - JWT roles "admin" and "data-protection-officer" are accepted;
 * - all other roles and credentials are rejected.
 */
tenantRateLimitOverridesRouter.use(requireAdminAuth);

tenantRateLimitOverridesRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.correlationId;

    const parseResult = createOverrideSchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn('Tenant rate-limit override request rejected', requestId, {
        operation: 'create',
        outcome: 'validation_error',
        issueCount: parseResult.error.issues.length,
      });
      res.status(400).json(
        errorResponse(
          'VALIDATION_ERROR',
          'Request validation failed',
          formatZodIssues(parseResult.error.issues),
          requestId,
        ),
      );
      return;
    }

    const { keyId, maxRequests, windowMs, expiresAt } = parseResult.data;

    try {
      const existing = await getOverrideByIdentity(keyId);
      if (existing) {
        logger.warn('Tenant rate-limit override request rejected', requestId, {
          operation: 'create',
          outcome: 'conflict',
          keyId,
        });
        res.status(409).json(
          errorResponse('CONFLICT', `An override for keyId '${keyId}' already exists.`, undefined, requestId),
        );
        return;
      }

      const createdBy = getAdminIdentity(req);
      const override = await createOverride({ keyId, maxRequests, windowMs, expiresAt }, createdBy);
      logger.info('Tenant rate-limit override created', requestId, {
        operation: 'create',
        outcome: 'success',
        overrideId: override.id,
        keyId: override.keyId,
      });
      res.status(201).json(successResponse(override, requestId));
    } catch (err) {
      // The pre-insert lookup is advisory. A concurrent request can insert the
      // same key before this request reaches the unique constraint, so retries
      // and races resolve to the same public 409 response as the fast path.
      if (isDuplicateEntryError(err)) {
        logger.warn('Tenant rate-limit override request rejected', requestId, {
          operation: 'create',
          outcome: 'conflict',
          keyId,
        });
        res.status(409).json(
          errorResponse('CONFLICT', `An override for keyId '${keyId}' already exists.`, undefined, requestId),
        );
        return;
      }

      if (respondToTemporaryFailure(err, 'create', requestId, res)) return;
      throw err;
    }
  }),
);

tenantRateLimitOverridesRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.correlationId;

    try {
      const overrides = await listOverrides();
      logger.info('Tenant rate-limit overrides listed', requestId, {
        operation: 'list',
        outcome: 'success',
        count: overrides.length,
      });
      res.json(successResponse(overrides, requestId));
    } catch (err) {
      if (respondToTemporaryFailure(err, 'list', requestId, res)) return;
      throw err;
    }
  }),
);

tenantRateLimitOverridesRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.correlationId;
    const { id } = req.params;

    try {
      await deleteOverride(id);
      logger.info('Tenant rate-limit override deleted', requestId, {
        operation: 'delete',
        outcome: 'success',
        overrideId: id,
      });
      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        logger.warn('Tenant rate-limit override request rejected', requestId, {
          operation: 'delete',
          outcome: 'not_found',
          overrideId: id,
        });
        res.status(404).json(
          errorResponse('NOT_FOUND', err.message, undefined, requestId),
        );
        return;
      }

      if (respondToTemporaryFailure(err, 'delete', requestId, res)) return;
      throw err;
    }
  }),
);
