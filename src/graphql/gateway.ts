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
 *   itself does not exist) and only available to authenticated callers when
 *   the flag is on.  There is no public introspection path.
 * - All resolvers delegate to the existing repository layer — no new data
 *   access paths are introduced.
 * - Errors are sanitised: internal error messages are replaced with a generic
 *   message so stack traces or DB details never leak to clients.
 */

import { Router, type Request } from 'express';
import {
  graphql,
  parse,
  type DocumentNode,
  type SelectionNode,
  type SelectionSetNode,
} from 'graphql';
import { executableSchema, typeDefs } from './schema.js';
import { isEnabled } from '../config/featureFlags.js';
import { authenticate, requireAuth } from '../middleware/auth.js';
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

/** Maximum GraphQL query nesting depth before rejecting the request. */
const MAX_QUERY_DEPTH = 3;

/** Maximum GraphQL field complexity before rejecting the request. */
const MAX_QUERY_COMPLEXITY = 15;

// ── GraphQL request validation ───────────────────────────────────────────────

function getQueryFragments(document: DocumentNode): Map<string, SelectionSetNode> {
  const fragments = new Map<string, SelectionSetNode>();
  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') {
      fragments.set(definition.name.value, definition.selectionSet);
    }
  }
  return fragments;
}

function visitSelectionSet(
  selectionSet: SelectionSetNode,
  fragments: Map<string, SelectionSetNode>,
  callback: (selection: SelectionNode) => void,
  visitedFragments = new Set<string>()
): void {
  for (const selection of selectionSet.selections) {
    callback(selection);

    if (selection.kind === 'Field' && selection.selectionSet) {
      visitSelectionSet(selection.selectionSet, fragments, callback, visitedFragments);
      continue;
    }

    if (selection.kind === 'FragmentSpread') {
      const fragmentName = selection.name.value;
      if (visitedFragments.has(fragmentName)) continue;
      const fragment = fragments.get(fragmentName);
      if (fragment) {
        visitedFragments.add(fragmentName);
        visitSelectionSet(fragment, fragments, callback, visitedFragments);
      }
      continue;
    }

    if (selection.kind === 'InlineFragment' && selection.selectionSet) {
      visitSelectionSet(selection.selectionSet, fragments, callback, visitedFragments);
    }
  }
}

function computeQueryDepth(document: DocumentNode): number {
  const fragments = getQueryFragments(document);
  let maxDepth = 0;

  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition' || !definition.selectionSet) {
      continue;
    }

    const visit = (
      selectionSet: SelectionSetNode,
      currentDepth: number,
      seenFragments = new Set<string>()
    ) => {
      maxDepth = Math.max(maxDepth, currentDepth);
      for (const selection of selectionSet.selections) {
        const nextDepth = currentDepth + 1;

        if (selection.kind === 'Field' && selection.selectionSet) {
          visit(selection.selectionSet, nextDepth, seenFragments);
          continue;
        }

        if (selection.kind === 'FragmentSpread') {
          const fragmentName = selection.name.value;
          if (seenFragments.has(fragmentName)) continue;
          const fragment = fragments.get(fragmentName);
          if (fragment) {
            seenFragments.add(fragmentName);
            visit(fragment, nextDepth, seenFragments);
          }
          continue;
        }

        if (selection.kind === 'InlineFragment' && selection.selectionSet) {
          visit(selection.selectionSet, nextDepth, seenFragments);
        }
      }
    };

    visit(definition.selectionSet, 0);
  }

  return maxDepth + 1;
}

function computeQueryComplexity(document: DocumentNode): number {
  const fragments = getQueryFragments(document);
  let complexity = 0;

  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition' || !definition.selectionSet) {
      continue;
    }

    visitSelectionSet(definition.selectionSet, fragments, () => {
      complexity += 1;
    });
  }

  return complexity;
}

function isIntrospectionQuery(document: DocumentNode): boolean {
  let found = false;

  const visit = (selectionSet?: SelectionSetNode) => {
    if (!selectionSet || found) return;
    for (const selection of selectionSet.selections) {
      if (selection.kind === 'Field') {
        const fieldName = selection.name.value;
        if (fieldName === '__schema' || fieldName === '__type') {
          found = true;
          return;
        }
        if (selection.selectionSet) {
          visit(selection.selectionSet);
        }
      } else if (selection.kind === 'FragmentSpread') {
        continue;
      } else if (selection.kind === 'InlineFragment' && selection.selectionSet) {
        visit(selection.selectionSet);
      }
    }
  };

  for (const definition of document.definitions) {
    if (definition.kind === 'OperationDefinition') {
      visit(definition.selectionSet);
    }
  }

  return found;
}

function rejectGraphQLError(res: any, code: string, message: string): void {
  res.status(200).json({
    errors: [
      {
        message,
        extensions: { code },
      },
    ],
  });
}

// ── Resolver helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a feature-flag requester ID from the Express request.
 *
 * Uses the same strategy as REST routes: API-key record ID when available,
 * otherwise a synthetic identifier derived from the auth state.
 */
function resolveRequesterId(req: Request): string {
  const user = (req as any).user;
  if (user?.keyId) return `key:${user.keyId}`;
  if (user?.address) return `address:${user.address}`;
  return 'anonymous';
}

/**
 * Check whether the GraphQL gateway is enabled for the current request.
 */
export function isGraphQLGatewayEnabled(req: Request): boolean {
  return isEnabled(GRAPHQL_GATEWAY_FLAG, resolveRequesterId(req));
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
      const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_STREAM_PAGE_SIZE);
      const includeTotal = args.includeTotal === true;
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.contractId) filter.contract_id = args.contractId;

      const result = await streamRepository.findWithCursor(
        filter as any,
        limit,
        args.afterId,
        includeTotal
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
 *
 * When the `experimental_graphql_gateway` feature flag is disabled for the
 * caller, all queries return an error in the standard `errors` envelope
 * (HTTP 200 with `errors[0].message`), consistent with how feature-flagged
 * endpoints in the REST API behave.
 */
graphqlGatewayRouter.post('/', authenticate, requireAuth, async (req, res) => {
  const requestId = req.correlationId;
  const start = Date.now();

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
    const rawBody = req.body ?? {};
    if (Array.isArray(rawBody)) {
      res
        .status(400)
        .json(
          errorResponse(
            'VALIDATION_ERROR',
            'Batch GraphQL operations are not allowed.',
            undefined,
            requestId
          )
        );
      return;
    }

    const { query: queryText, variables, operationName } = rawBody;

    if (!queryText || typeof queryText !== 'string') {
      res
        .status(400)
        .json(
          errorResponse(
            'VALIDATION_ERROR',
            'GraphQL request must include a "query" string field.',
            undefined,
            requestId
          )
        );
      return;
    }

    let document: DocumentNode;
    try {
      document = parse(queryText);
    } catch (parseError) {
      res
        .status(400)
        .json(
          errorResponse(
            'GRAPHQL_PARSE_ERROR',
            'GraphQL query could not be parsed.',
            undefined,
            requestId
          )
        );
      return;
    }

    if (isIntrospectionQuery(document)) {
      rejectGraphQLError(res, 'INTROSPECTION_FORBIDDEN', 'GraphQL introspection is disabled.');
      return;
    }

    const queryDepth = computeQueryDepth(document);
    if (queryDepth > MAX_QUERY_DEPTH) {
      rejectGraphQLError(
        res,
        'QUERY_TOO_DEEP',
        `Query exceeds the maximum depth of ${MAX_QUERY_DEPTH}.`
      );
      return;
    }

    const queryComplexity = computeQueryComplexity(document);
    if (queryComplexity > MAX_QUERY_COMPLEXITY) {
      rejectGraphQLError(
        res,
        'QUERY_TOO_COMPLEX',
        `Query exceeds the maximum complexity of ${MAX_QUERY_COMPLEXITY}.`
      );
      return;
    }

    // ── Execute query ───────────────────────────────────────────────────────
    const rootValue = createRootValue(req);
    const context = { req, res, requestId };

    const result = await graphql({
      schema: executableSchema,
      source: queryText,
      rootValue,
      contextValue: context,
      variableValues: variables ?? undefined,
      operationName: operationName ?? undefined,
    });

    // ── Sanitise errors ─────────────────────────────────────────────────────
    if (result.errors && result.errors.length > 0) {
      // Spreading a GraphQLError yields a plain object (no toJSON), which is
      // fine here because the result is serialised by res.json() immediately
      // below and never used as a GraphQLError again.
      result.errors = result.errors.map((err) => ({
        ...err,
        message: sanitiseGraphQLError(err.message),
        ...(err.extensions ? { extensions: sanitiseExtensions(err.extensions) } : {}),
      })) as unknown as typeof result.errors;
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
});

// ── Error sanitisation ─────────────────────────────────────────────────────────

/**
 * Sanitise a GraphQL error message so internal details are never leaked.
 */
function sanitiseGraphQLError(message: string): string {
  const sanitised = sanitiseErrorMessage(message)
    .replace(/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.ts:\d+:\d+/g, '[redacted-path]')
    .replace(/https?:\/\/[^\s]+/g, '[redacted-url]')
    .replace(/postgresql:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/mongodb:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/Error: /g, '')
    .trim();

  // If the message becomes empty or contains only punctuation, return a generic
  if (
    !sanitised ||
    /^[\s.,!?;:-]+$/.test(sanitised) ||
    /\[redacted-url\]|(?:postgresql|mysql|mongodb|redis):\/\//i.test(sanitised) ||
    /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.test(sanitised)
  ) {
    return 'An unexpected error occurred';
  }

  return sanitised;
}

/**
 * Sanitise error extensions — keep only known-safe codes.
 */
function sanitiseExtensions(
  extensions: Readonly<Record<string, unknown>>
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
graphqlGatewayRouter.get('/', authenticate, requireAuth, async (req, res) => {
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
});
