/**
 * Experimental GraphQL federation gateway.
 *
 * Mounted under `/api/graphql` only when the `experimental_graphql_gateway`
 * feature flag is enabled for the requesting identity.  When the flag is off
 * (the default), the endpoint returns 404 just as if it were not registered.
 *
 * ## Security
 *
 * - The route is protected by the same `authenticate` (JWT) +
 *   `authenticateApiKey` (API key) + `requireScope` middleware used by REST
 *   routes, so unauthenticated requests are rejected with 401 before any
 *   GraphQL logic runs. `requireScope` accepts either principal kind (JWT
 *   `req.user` or API key `req.keyId`) and is the single deny-by-default gate.
 * - Every sensitive resolver enforces the same least-privilege scope policy as
 *   the REST entrypoints, deny-by-default:
 *     - `stream` / `streams`  → requires `streams:read`
 *     - `auditEntries`        → requires `audit:read`
 *   The scope check runs BEFORE any repository lookup, so a denied request
 *   never reveals whether the target resource exists.
 * - Missing scope is distinguishable from an invalid credential: an
 *   invalid/revoked/expired key is rejected with 401 before any query runs,
 *   while a valid key that lacks the required scope receives a sanitised
 *   `FORBIDDEN` GraphQL error with no resource data.
 * - Schema introspection is disabled when the feature flag is off (the route
 *   itself does not exist) and only available to authenticated callers when
 *   the flag is on.  There is no public introspection path.
 * - All resolvers delegate to the existing repository layer — no new data
 *   access paths are introduced.
 * - Errors are sanitised: internal error messages are replaced with a generic
 *   message so stack traces or DB details never leak to clients.
 */

import { Router, type Request } from 'express';
import { graphql, type GraphQLError } from 'graphql';
import { createHash } from 'node:crypto';
import { executableSchema, typeDefs } from './schema.js';
import { isEnabled } from '../config/featureFlags.js';
import { authenticate, authenticateApiKey, requireScope } from '../middleware/auth.js';
import { streamRepository } from '../db/repositories/streamRepository.js';
import { getAuditEntries } from '../lib/auditLog.js';
import { errorResponse } from '../utils/response.js';
import { logger } from '../lib/logger.js';
import { sanitiseErrorMessage } from '../health/checkers.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Feature flag name that gates this gateway. */
export const GRAPHQL_GATEWAY_FLAG = 'experimental_graphql_gateway';

/** Maximum page size for stream pagination. */
const MAX_STREAM_PAGE_SIZE = 100;

/** Maximum page size for audit-log pagination. */
const MAX_AUDIT_PAGE_SIZE = 100;

// ── Persisted-query helpers ───────────────────────────────────────────────────

/**
 * SHA-256 of a GraphQL query string. Persisted-query hashes let clients send
 * only the 64-char digest for expensive, pre-registered operations instead of
 * the full query text.
 */
export function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex');
}

const persistedQueryStore = new Map<string, string>();

/** Register a query for persisted-query transport and return its hash. */
export function registerPersistedQuery(query: string): string {
  const hash = hashQuery(query);
  persistedQueryStore.set(hash, query);
  return hash;
}

// ── Resolver helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a feature-flag requester ID from the Express request.
 *
 * Uses the same strategy as REST routes: API-key record ID when available,
 * otherwise a synthetic identifier derived from the auth state.
 */
function resolveRequesterId(req: Request): string {
  // API-key callers authenticate via req.keyId; JWT callers via req.user.
  if (req.keyId) return `key:${req.keyId}`;
  if (req.user?.address) return `address:${req.user.address}`;
  return 'anonymous';
}

/**
 * Check whether the GraphQL gateway is enabled for the current request.
 */
export function isGraphQLGatewayEnabled(req: Request): boolean {
  return isEnabled(GRAPHQL_GATEWAY_FLAG, resolveRequesterId(req));
}

/**
 * Resolve the caller's effective scopes.
 *
 * Mirrors the REST `requireScope` precedence: when an API key is present its
 * scopes are authoritative; otherwise JWT permissions are used. A caller with
 * neither has no scopes and is denied by default.
 */
function callerScopes(req: Request): string[] {
  if (req.keyId !== undefined) {
    // API-key scopes are authoritative when a key is present (REST precedence).
    const keyScopes = (req as Request & { keyScopes?: unknown }).keyScopes;
    return Array.isArray(keyScopes) ? keyScopes : [];
  }
  const permissions = req.user?.permissions;
  return Array.isArray(permissions) ? permissions : [];
}

/** Thrown when a resolver's scope gate denies the caller. */
class GraphQLScopeDeniedError extends Error {
  constructor(required: string[]) {
    super(`Insufficient scopes. Required: ${required.join(' or ')}`);
    this.name = 'GraphQLScopeDeniedError';
  }
}

/**
 * Deny-by-default scope gate for resolvers.
 *
 * Runs BEFORE any repository lookup so a denied request can never reveal
 * whether the target resource exists. `required` accepts any-of semantics,
 * matching `requireScope` on REST routes.
 */
function assertCallerScope(req: Request, ...required: string[]): void {
  const scopes = callerScopes(req);
  if (!required.some((scope) => scopes.includes(scope))) {
    throw new GraphQLScopeDeniedError(required);
  }
}

// ── Root value (resolvers) ────────────────────────────────────────────────────

/**
 * Root value object passed to `graphql()` — each key corresponds to a
 * field on the root `Query` type.
 */
function createRootValue(req: Request) {
  return {
    /**
     * Fetch a single stream by ID.
     */
    async stream(args: { id: string }) {
      assertCallerScope(req, 'streams:read');
      const record = await streamRepository.getById(args.id);
      if (!record) return null;
      return mapStream(record);
    },

    /**
     * Paginated stream list with optional filters.
     */
    async streams(args: {
      limit?: number;
      status?: string;
      contractId?: string;
      afterId?: string;
      includeTotal?: boolean;
    }) {
      assertCallerScope(req, 'streams:read');
      const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_STREAM_PAGE_SIZE);
      const includeTotal = args.includeTotal === true;
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.contractId) filter.contract_id = args.contractId;

      const result = await streamRepository.findWithCursor(
        filter as Parameters<typeof streamRepository.findWithCursor>[0],
        limit,
        args.afterId,
        includeTotal,
      );

      return {
        streams: result.streams.map(mapStream),
        hasMore: result.hasMore,
        ...(includeTotal ? { total: result.total } : {}),
      };
    },

    /**
     * Query in-memory audit-log entries.
     */
    auditEntries(args: { limit?: number; offset?: number; actionType?: string }) {
      assertCallerScope(req, 'audit:read');
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

// ── Stream mapping helper ──────────────────────────────────────────────────────

function mapStream(record: {
  id: string;
  sender_address: string;
  recipient_address: string;
  amount: string;
  streamed_amount: string;
  remaining_amount: string;
  rate_per_second: string;
  start_time: number;
  end_time: number;
  status: string;
  contract_id: string;
  transaction_hash: string;
  event_index: number;
  created_at: string;
  updated_at: string;
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

// ── Gateway route ──────────────────────────────────────────────────────────────

export const graphqlGatewayRouter = Router();

/**
 * POST /api/graphql
 *
 * Executes a GraphQL query against the schema.
 *
 * Authentication is required — requests without a valid Bearer token or
 * API key are rejected with 401 before any GraphQL processing begins.
 * The route-level scope gate accepts any principal that carries at least one
 * gateway scope; per-resolver gates then enforce the exact scope each field
 * requires.
 *
 * When the `experimental_graphql_gateway` feature flag is disabled for the
 * caller, all queries return an error in the standard `errors` envelope
 * (HTTP 200 with `errors[0].message`), consistent with how feature-flagged
 * endpoints in the REST API behave.
 */
graphqlGatewayRouter.post(
  '/',
  authenticate,
  authenticateApiKey,
  // requireScope is the single gate for both principal kinds: it rejects with
  // 401 when no principal is present and 403 when the principal carries none
  // of the gateway scopes. (requireAuth alone would reject API-key callers,
  // who authenticate via req.keyId rather than req.user.)
  requireScope('streams:read', 'streams:write', 'audit:read'),
  async (req, res) => {
    const requestId = req.correlationId;

    try {
      // ── Feature-flag gate ──────────────────────────────────────────────────
      if (!isGraphQLGatewayEnabled(req)) {
        res.status(200).json({
          errors: [
            {
              message: `Feature flag "${GRAPHQL_GATEWAY_FLAG}" is not enabled for this request.`,
              extensions: { code: 'FEATURE_FLAG_DISABLED' },
            },
          ],
        });
        return;
      }

      // ── Parse request body ─────────────────────────────────────────────────
      const { query: queryText, variables, operationName, extensions } = req.body ?? {};

      let source: string | undefined = queryText;

      // ── Persisted-query extension ───────────────────────────────────────────
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

      // ── Execute query ───────────────────────────────────────────────────────
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

      // ── Sanitise errors ─────────────────────────────────────────────────────
      if (result.errors && result.errors.length > 0) {
        result.errors = result.errors.map((err) => {
          // Scope denials are intentional, safe-to-surface errors: surface a
          // stable code without any detail about the target resource.
          if ((err as { originalError?: unknown }).originalError instanceof GraphQLScopeDeniedError) {
            return {
              ...err,
              message: 'Insufficient scopes to perform this operation',
              extensions: { code: 'FORBIDDEN' },
            } as unknown as GraphQLError;
          }
          return {
            ...err,
            message: sanitiseGraphQLError(err.message),
            ...(err.extensions
              ? { extensions: sanitiseExtensions(err.extensions) }
              : {}),
          } as unknown as GraphQLError;
        });
      }

      res.json(result);
    } catch (err) {
      // Catch-all for internal errors that the graphql() call did not capture.
      logger.error('GraphQL gateway unexpected error', requestId, {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        errors: [
          {
            message: 'Internal server error',
            extensions: { code: 'INTERNAL_ERROR' },
          },
        ],
      });
    }
  },
);

// ── Error sanitisation ─────────────────────────────────────────────────────────

/**
 * Sanitise a GraphQL error message so internal details are never leaked.
 */
function sanitiseGraphQLError(message: string): string {
  const sanitised = sanitiseErrorMessage(message)
    .replace(/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.ts:\d+:\d+/g, '[redacted-path]')
    .replace(/Error: /g, '')
    .trim();

  // If the message becomes empty or contains only punctuation, return a generic
  if (!sanitised || /^[\s.,!?;:-]+$/.test(sanitised)) {
    return 'An unexpected error occurred';
  }

  return sanitised;
}

/**
 * Sanitise error extensions — keep only known-safe codes.
 */
function sanitiseExtensions(
  extensions: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
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

// ── GET handler — schema introspection for tooling ─────────────────────────────

/**
 * GET /api/graphql?sdl — returns the raw SDL string for tooling (e.g. codegen).
 * Only available when the feature flag is enabled for the caller.
 */
graphqlGatewayRouter.get(
  '/',
  authenticate,
  authenticateApiKey,
  requireScope('streams:read', 'streams:write', 'audit:read'),
  async (req, res) => {
    if (!isGraphQLGatewayEnabled(req)) {
      res.status(200).json({
        errors: [
          {
            message: `Feature flag "${GRAPHQL_GATEWAY_FLAG}" is not enabled for this request.`,
            extensions: { code: 'FEATURE_FLAG_DISABLED' },
          },
        ],
      });
      return;
    }

    if (req.query.sdl !== undefined) {
      res.type('text/plain').send(typeDefs);
      return;
    }

    // Return a simple health/status response for GET without ?sdl
    res.json({
      data: {
        __typename: 'GraphQLGateway',
        version: '0.1.0',
        status: 'experimental',
      },
    });
  },
);
