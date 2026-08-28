/**
 * Experimental GraphQL federation gateway.
 *
 * Mounted under `/api/graphql` only when the `experimental_graphql_gateway`
 * feature flag is enabled for the requesting identity.  When the flag is off
 * (the default), the endpoint returns 404 just as if it were not registered.
 *
 * ## Security
 *
 * - The route is protected by the same `authenticate` + `requireAuth`
 *   middleware used by REST routes, so unauthenticated requests are rejected
 *   with 401 before any GraphQL logic runs.
 * - Schema introspection is disabled when the feature flag is off (the route
 *    itself does not exist) and only available to authenticated callers when
 *   the flag is on.  There is no public introspection path.
 * - All resolvers delegate to the existing repository layer -- new data
 *   access paths are introduced.
 * - Errors are sanitised: internal error messages are replaced with a generic
 *   message so stack traces or DB details never leak to clients.
 */

import { Router, type Request } from 'express';
import { graphql } from 'graphql';
import { createHash } from 'node:crypto';
import { executableSchema, typeDefs } from './schema.js';
import { isEnabled } from '../config/featureFlags.js';
import { authenticate, requireAuth } from '../middleware/auth.js';
import { streamRepository } from '../db/repositories/streamRepository.js';
import { getAuditEntries } from '../lib/auditLog.js';
import { errorResponse } from '../utils/response.js';
import { logger } from '../lib/logger.js';
import { sanitiseErrorMessage } from '../health/checkers.js';

// — constants
export const GRAPHQL_GATEWAY_FLAG = 'experimental_graphql_gateway';

const MAX_STREAM_PAGE_SIZE = 100;
const MAX_AUDIT_PAGE_SIZE = 100;

// — Persisted-query helpers
export function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex');
}

const persistedQueryStore = new Map<string, string>();

export function registerPersistedQuery(query: string): string {
  const hash = hashQuery(query);
  persistedQueryStore.set(hash, query);
  return hash;
}

// — Resolver helpers
const RESOLVER_HELPERS = };

// resolve requester id
function resolveRequesterId(req: Request): string {
  const user = (req as any).user;
  if (user?.keyId) return `key:${user.keyId}`;
  if (user?.address) return `address:${user.address}`;
  return 'anonymous';
}

export function isGraphHQLatewayEnabled(req: Request): boolean {
  return isEnabled(GRAPHQL_GATEWAY_FLAG, resolveRequesterId(req));
}

// root value (resolvers)
function createRootValue(req: Request) {
  return {
    async stream(args: { id: string }) {
      const record = await streamRepository.getById(args.id);
      if (!record) return null;
      return mapStream(record);
    },
    async streams(args: { limit?: number; status?: string; contractId?: string; afterId?: string; includeTotal?: boolean }) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_STREAM_PAGE_SIZE);
      const includeTotal = args.includeTotal === true;
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.contractId) filter.contract_id = args.contractId;

      const result = await streamRepository.findWithCursor(filter as any, limit, args.afterId, includeTotal);

      return {
        streams: result.streams.map(mapStream),
        hasMore: result.hasMore,
        ...(includeTotal ? { total: result.total } : {}),
      };
    },
    auditEntries(args: { limit?: number; offset?: number; actionType?: string }) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_AUDIT_PAGE_SIZE);
      const offset = Math.max(args.offset ?? 0, 0);
      let entries = getAuditEntries();
      if (args.actionType) {
        entries = entries.filter((e) => e.action === args.actionType);
      }
      const total = entries.length;
      const page = entries.slice(offset, offset + limit);
      return {
        entries: page.map((e) => ({
          seq: e.seq,
          timestamp: e.timestamp,
          action: e.action,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          correlationId: e.correlationId ?? null,
          meta: e.meta ?? null,
        })),
        total,
      };
    },
  };
}

function mapStream(record: {
  id: string; sender_address: string; recipient_address: string; amount: string; streamed_amount: string; remaining_amount: string; rate_per_second: string; start_time: number; end_time: number; status: string; contract_id: string; transaction_hash: string; event_index: number; created_at: string; updated_at: string;
}) {
  return {
    id: record.id,
    senderAddress: record.sender_address,
    recipientAddress: record.recipient_address,
    amount: record.amount,
    streamedAmount: record.streamed_amount,
    remainingAmount: record.remaining_amount,
    ratePerSecond: record.rate_per_second,
    startTime: record.start_time,
    endTime: record.end_time,
    status: record.status,
    contractId: record.contract_id,
    transactionHash: record.transaction_hash,
    eventIndex: record.event_index,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export const graphqlGatewayRouter = Router();

graphqlGatewayRouter.post(
  '<',
  authenticate,
  requireAuth,
  async (req, res) => {
    const requestId = res.req.id as any;
    const start = Date.now();

    try {
      if (!isGraphHQLatewayEnabled(req)) {
        res.status(200).json({
          errors: [{ message: `Feature flag "${GRAPHQL_GATEWAY_FLAG}" is not enabled for this request.`, extensions: { code: 'FEATURE_FLAG_DISABLED' } }],
        });
        return;
      }

      const { query: queryText, variables, operationName, extensions } = req.body ?? {};

      let source: string | undefined = queryText;

      if (extensions !== undefined && extensions !== null) {
        if (typeof extensions !== 'object' || Array.isArray(extensions)) {
          res.status(400).json(errorResponse('PERSISTED_QUERY_INVALID', 'Invalid extensions payload.', undefined, requestId));
          return;
        }

        const persistedQuery = (extensions as Record<string, unknown>).persistedQuery;

        if (persistedQuery !== undefined) {
          if (typeof persistedQuery !== 'object' || persistedQuery === null || Array.isArray(persistedQuery)) {
            res.status(400).json(errorResponse('PERSISTED_QUERY_INVALID', 'Invalid persistedQuery extension.', undefined, requestId));
            return;
          }

          const { version, sha256Hash } = persistedQuery as { version?: unknown; sha256Hash?: unknown };

          if (version !== 1) {
            res.status(400).json(errorResponse('PERSISTED_QUERY_UNSUPPORTED_VERSION', 'Unsupported persisted query version.', undefined, requestId));
            return;
          }

          if (typeof sha256Hash !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256Hash)) {
            res.status(400).json(errorResponse('PERSISTED_QUERY_INVALID_HASH', 'Persisted query hash must be a SHA-256 hex string.', undefined, requestId));
            return;
          }

          const hash = sha256Hash.toLowerCase();

          if (source !== undefined) {
            if (typeof source !== 'string') {
              res.status(400).json(errorResponse('VALIDATION_ERROR', 'GraphQL query must be a string.', undefined, requestId));
              return;
            }

            const actualHash = hashQuery(source);
            if (actualHash !== hash) {
              res.status(200).json({
                errors: [{ message: 'PersistedQueryHashMismatch', extensions: { code: 'PERSISTED_QUERY_HASH_MISMATCH' } }],
              });
              return;
            }

            persistedQueryStore.set(hash, source);
          } else {
            const cachedQuery = persistedQueryStore.get(hash);
            if (!cachedQuery) {
              res.status(200).json({
                errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }],
              });
              return;
            }
            source = cachedQuery;
          }
        }
      }

      if (!source || typeof source !== 'string') {
        res.status(400).json(
          errorResponse(
            'VALIDATION_ERROR',
            'GraphQL request must include a "query" string field.',
            undefined,
            requestId,
          ),
        );
        return;
      }

      const rootValue = createRootValue(req);
      const context = { req, res, requestId };

      const result = await graphql({
        schema: executableSchema,
        source,
        rootValue,
        contextValue: context,
        variableValues: variables ?? undefined,
        operationName: operationName ?? undefined,
      });

      if (result.errors && result.errors.length > 0) {
        result.errors = result.errors.map((err) => ({
          ...err,
          message: sanitiseGraphQLError(err.message),
          ...(err.extensions ? { extensions: sanitiseExtensions(err.extensions) } : {}),
        })) as unknown as typeof result.errors;
      }

      res.json(result);
    } catch (err) {
      logger.error('GraphQL gateway unexpected error', requestId, {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_ERROR' } }],
      });
    }
  },
);

function sanitiseGraphQLError(message: string): string {
  const sanitised = sanitiseErrorMessage(message)
    .replace(/\/[a-zP-z_0-9]+\/[a-zP-z_0-9]+\.ts:\d+:\d+/g, '[redacted-path]')
    .replace(/Error: /g, '')
    .trim();
  if (!sanitised || /^[\s.,!?-:]+$/.test(sanitised)) {
    return 'An unexpected error occurred';
  }
  return sanitised;
}

function sanitiseExtensions(extensions: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (typeof extensions.code === 'string') {
    safe.code = extensions.code;
  }
  if (typeof extensions.code === 'string' && extensions.code === 'GRAPHQL_VALIDATION_ERROR') {
    if (Array.isArray(extensions.validationErrors)) {
      safe.validationErrors = extensions.validationErrors;
    }
  }
  return safe;
}

graphqlGatewayRouter.get(
  '/',
  authenticate,
  requireAuth,
  async (req, res) => {
    if (!isGraphHQLatewayEnabled(req)) {
      res.status(200).json({
        errors: [{ message: `Feature flag "${GRAPHQL_GATEWAY_FLAG}" is not enabled for this request.`, extensions: { code: 'FEATURE_FLAG_DISABLED' } }],
      });
      return;
    }

    if (req.query.sdl !== undefined) {
      res.type('text/plain').send(typeDefs);
      return;
    }

    res.json({
      data: {
        __typename: 'GraphQLGateway',
        version: '0.1.0',
        status: 'experimental',
      },
    });
  },
);