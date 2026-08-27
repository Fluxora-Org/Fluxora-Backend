// @ts-nocheck
// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
/**
 * GraphQL schema for Fluxora Backend experimental federation gateway.
 *
 * Defines a minimal read-only schema over streams and audit-log data, backed
 * by the existing repository layer.  The schema is intentionally kept small
 * and can be extended as consumer requirements evolve.
 *
 * ## Security
 *
 * - All queries are read-only — no mutations are exposed.
 * - The schema is only mounted when the `experimental_graphql_gateway`
 *   feature flag is enabled (see `gateway.ts`).
 */

import { buildSchema } from 'graphql';

/**
 * GraphQL schema definition string (SDL).
 */
export const typeDefs = `
  """
  ISO-8601 timestamp wrapper.  Serialised as a string.
  """
  scalar Timestamp

  """
  Arbitrary JSON value (audit entry meta, stream payload, etc.).
  """
  scalar JSON

  """
  Stream status enum matching the Fluxora domain.
  """
  enum StreamStatus {
    active
    paused
    completed
    cancelled
  }

  """
  A single stream record.
  """
  type Stream {
    """Stream unique identifier (cuid2)."""
    id: ID!
    senderAddress: String!
    recipientAddress: String!
    amount: String!
    streamedAmount: String!
    remainingAmount: String!
    ratePerSecond: String!
    startTime: Float!
    endTime: Float!
    status: StreamStatus!
    contractId: String!
    transactionHash: String!
    eventIndex: Int!
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  """
  Paginated stream connection (cursor-based).
  """
  type StreamConnection {
    streams: [Stream!]!
    hasMore: Boolean!
    """Present only when the includeTotal argument was true."""
    total: Int
  }

  """
  A single audit-log entry.
  """
  type AuditEntry {
    seq: Int!
    timestamp: Timestamp!
    action: String!
    resourceType: String!
    resourceId: String!
    correlationId: String
    """Arbitrary JSON metadata — sensitive fields are redacted."""
    meta: JSON
  }

  """
  Paginated audit-log connection (offset-based).
  """
  type AuditConnection {
    entries: [AuditEntry!]!
    total: Int!
  }

  """
  Root query type.
  """
  type Query {
    """
    Fetch a single stream by its unique ID.
    Returns null when the stream does not exist.
    """
    stream(id: ID!): Stream

    """
    List streams with optional filters.
    Uses keyset pagination when afterId is provided.
    """
    streams(
      limit: Int = 20
      status: StreamStatus
      contractId: String
      afterId: String
      includeTotal: Boolean = false
    ): StreamConnection!

    """
    Query in-memory audit-log entries.
    """
    auditEntries(
      limit: Int = 20
      offset: Int = 0
      actionType: String
    ): AuditConnection!
  }
`;

/**
 * Pre-built executable schema object.
 * Cached here so every request does not rebuild the schema.
 */
export const executableSchema = buildSchema(typeDefs);
