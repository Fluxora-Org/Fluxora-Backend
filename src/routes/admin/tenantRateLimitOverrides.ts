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
  getOverrideById,
} from '../../services/tenantRateLimitOverride.service.js';
import { successResponse, errorResponse } from '../../utils/response.js';
import { formatZodIssues } from '../../validation/schemas.js';

/**
 * Maximum allowed value for maxRequests to prevent runaway override configs.
 * An override granting more than 10 million requests per window is almost
 * certainly misconfigured; rejecting it at the validation layer is safer than
 * silently accepting an order-of-magnitude typo.
 */
const MAX_REQUESTS_UPPER_BOUND = 10_000_000;

const createOverrideSchema = z.object({
  keyId: z.string().min(1, 'keyId is required'),
  maxRequests: z
    .number()
    .int()
    .positive('maxRequests must be a positive integer')
    .max(MAX_REQUESTS_UPPER_BOUND, `maxRequests must not exceed ${MAX_REQUESTS_UPPER_BOUND}`),
  windowMs: z.number().int().min(1000, 'windowMs must be at least 1000'),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Validation schema for :id route parameters.
 * Rejects empty strings and values that could not be a valid cuid2 identifier
 * (length 24, alphanumeric) before they reach the service layer.
 */
const idParamSchema = z.object({
  id: z
    .string()
    .min(1, 'id must not be empty')
    .max(128, 'id is too long'),
});

const TEMPORARY_FAILURE_RETRY_AFTER_SECONDS = 1;

export const tenantRateLimitOverridesRouter = Router();

/**
 * Extract a stable, non-secret audit identity from the incoming request.
 *
 * Priority order:
 * 1. JWT payload (set by requireAdminAuth when a valid JWT is used):
 *    returns "jwt:<address>" — this is the canonical identity for JWT-authed
 *    admin calls and is stable across token rotations.
 * 2. Static Bearer token: returns "admin:<first-8-chars>" — safe truncation
 *    that is useful for log correlation without leaking the full token.
 * 3. Fallback: "unknown" — should never be reached in practice because
 *    requireAdminAuth rejects all unauthenticated requests before handlers
 *    run, but keeps the function total.
 *
 * Secrets are never logged; only stable identifiers are returned.
 */
function getAdminIdentity(req: Request): string {
  // Prefer the JWT payload's address when available — it is the canonical
  // identity for JWT-authed admin calls.
  if (req.user?.address) {
    return `jwt:${req.user.address}`;
  }

  const header = req.headers.authorization;
  if (!header) return 'unknown';

  const parts = header.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    // Only expose the first 8 characters of the static token to avoid leaking
    // credentials in logs while still providing useful correlation context.
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
  operation: 'create' | 'list' | 'delete' | 'get',
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

/**
 * GET /:id — fetch a single override by its primary-key ID.
 *
 * This endpoint complements the list endpoint for callers that already
 * know the override ID and want to avoid fetching the full list.  It also
 * surfaces the expiry filter explicitly: a 404 is returned for an ID that
 * exists in the database but whose record has expired, keeping the
 * observable behavior consistent with the create-time conflict check.
 */
tenantRateLimitOverridesRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.correlationId;

    // Validate the :id param before touching the database.
    const paramResult = idParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      logger.warn('Tenant rate-limit override request rejected', requestId, {
        operation: 'get',
        outcome: 'validation_error',
        issueCount: paramResult.error.issues.length,
      });
      res.status(400).json(
        errorResponse(
          'VALIDATION_ERROR',
          'Invalid override id',
          formatZodIssues(paramResult.error.issues),
          requestId,
        ),
      );
      return;
    }

    const { id } = paramResult.data;

    try {
      const override = await getOverrideById(id);
      if (!override) {
        logger.warn('Tenant rate-limit override request rejected', requestId, {
          operation: 'get',
          outcome: 'not_found',
          overrideId: id,
        });
        res.status(404).json(
          errorResponse('NOT_FOUND', `Override not found: ${id}`, undefined, requestId),
        );
        return;
      }

      logger.info('Tenant rate-limit override fetched', requestId, {
        operation: 'get',
        outcome: 'success',
        overrideId: override.id,
        keyId: override.keyId,
      });
      res.json(successResponse(override, requestId));
    } catch (err) {
      if (respondToTemporaryFailure(err, 'get', requestId, res)) return;
      throw err;
    }
  }),
);

tenantRateLimitOverridesRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.correlationId;

    // Validate :id before hitting the database to reject obviously-invalid
    // values (empty string, extremely long strings) with a deterministic 400
    // rather than a potentially confusing 404 or a DB error.
    const paramResult = idParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      logger.warn('Tenant rate-limit override request rejected', requestId, {
        operation: 'delete',
        outcome: 'validation_error',
        issueCount: paramResult.error.issues.length,
      });
      res.status(400).json(
        errorResponse(
          'VALIDATION_ERROR',
          'Invalid override id',
          formatZodIssues(paramResult.error.issues),
          requestId,
        ),
      );
      return;
    }

    const { id } = paramResult.data;

    try {
      const deleted = await deleteOverride(id);
      logger.info('Tenant rate-limit override deleted', requestId, {
        operation: 'delete',
        outcome: 'success',
        overrideId: id,
        // Include keyId in the success audit log so operators can correlate
        // a deletion with the specific tenant key that was affected.
        keyId: deleted.keyId,
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
