/**
 * gRPC transcoding gateway for the Fluxora indexer.
 *
 * Exposes the same replay / ingest operations as src/routes/indexer.ts but
 * over gRPC, using the IndexerService proto definition below.  All handler
 * logic delegates directly to the shared `indexerIngestionService` and
 * `indexerService` singletons so there is zero duplication of business logic.
 *
 * The server is feature-flagged via `GRPC_GATEWAY_ENABLED` (default: false)
 * so existing HTTP-only deployments are completely unaffected.
 *
 * Security model
 * --------------
 * - Every RPC carries a `worker_token` metadata header that is checked against
 *   the `INDEXER_WORKER_TOKEN` environment variable, mirroring the
 *   `x-indexer-worker-token` check on the HTTP routes.
 * - Tokens are compared with a constant-time equality check to prevent
 *   timing-oracle attacks.
 * - The server binds on an internal port (default 50052) and must NOT be
 *   exposed outside the cluster.
 *
 * Proto inline pattern
 * --------------------
 * The proto definition is kept as an in-memory string rather than read from
 * disk.  The production Docker image only ships `dist/`, not `src/`, so a
 * runtime `fs.readFileSync` against a `.proto` file would fail once deployed.
 * This mirrors the pattern used by src/health/grpcHealth.ts.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import { getConfig } from '../config/env.js';
import {
  indexerIngestionService,
  indexerService,
} from './service.js';
import { logger } from '../lib/logger.js';
import { ReplayRequestSchema } from '../validation/schemas.js';

// ── Proto definition (inline — no disk reads in production) ─────────────────
//
// Keep this in sync with any future .proto file added to the repo.
// Field numbers are stable; do not renumber existing fields.

const INDEXER_PROTO_SOURCE = `
syntax = "proto3";
package fluxora.indexer.v1;

// ── Ingest RPC ────────────────────────────────────────────────────────────────

message ContractEvent {
  string eventId        = 1;
  int32  ledger         = 2;
  string contractId     = 3;
  string topic          = 4;
  string txHash         = 5;
  int32  txIndex        = 6;
  int32  operationIndex = 7;
  int32  eventIndex     = 8;
  string payloadJson    = 9;  // JSON-encoded payload (opaque blob)
  string happenedAt     = 10;
  string ledgerHash     = 11;
}

message IngestContractEventsRequest {
  repeated ContractEvent events = 1;
}

message IngestContractEventsResponse {
  int32           insertedCount    = 1;
  int32           duplicateCount   = 2;
  repeated string insertedEventIds = 3;
  repeated string duplicateEventIds = 4;
}

// ── GetEvents RPC ─────────────────────────────────────────────────────────────

message GetEventsRequest {
  int32  fromLedger   = 1;
  int32  toLedger     = 2;
  string contractId   = 3;
  string topic        = 4;
  int32  limit        = 5;
  int32  offset       = 6;
  string afterEventId = 7; // cursor-based pagination
}

message StreamEventRecord {
  string eventId    = 1;
  int32  ledger     = 2;
  string contractId = 3;
  string topic      = 4;
  string txHash     = 5;
  string payloadJson = 6;
  string happenedAt = 7;
  string ledgerHash = 8;
}

message GetEventsResponse {
  repeated StreamEventRecord events = 1;
  int32  total      = 2;
  int32  limit      = 3;
  int32  offset     = 4;
  string nextCursor = 5;
}

// ── ReplayEvents RPC ──────────────────────────────────────────────────────────

message ReplayEventsRequest {
  string contractId = 1;
  int32  ledger     = 2;
  int32  fromBlock  = 3;
  int32  toBlock    = 4;
}

message ReplayEventsResponse {
  string message       = 1;
  bool   isReplaying   = 2;
  int32  rowsReplayed  = 3;
  int32  rowsRemaining = 4;
  int32  totalRows     = 5;
}

// ── GetReplayStatus RPC ───────────────────────────────────────────────────────

message GetReplayStatusRequest {}

message GetReplayStatusResponse {
  bool   isReplaying          = 1;
  int32  rowsReplayed         = 2;
  int32  rowsRemaining        = 3;
  int32  totalRows            = 4;
  string estimatedCompletion  = 5;
  string startedAt            = 6;
  string contractId           = 7;
  int32  ledger               = 8;
}

// ── Service ───────────────────────────────────────────────────────────────────

service IndexerService {
  // Ingest a batch of contract events from the chain worker.
  // Requires worker_token metadata header.
  rpc IngestContractEvents(IngestContractEventsRequest) returns (IngestContractEventsResponse);

  // Replay stored events with optional filtering.
  // Requires worker_token metadata header.
  rpc GetEvents(GetEventsRequest) returns (GetEventsResponse);

  // Trigger a historical DB backfill for a given contract/ledger range.
  // Requires worker_token metadata header.
  rpc ReplayEvents(ReplayEventsRequest) returns (ReplayEventsResponse);

  // Return current replay progress.
  // Requires worker_token metadata header.
  rpc GetReplayStatus(GetReplayStatusRequest) returns (GetReplayStatusResponse);
}
`;

// ── TypeScript interfaces matching the proto messages ────────────────────────
//
// NOTE: @grpc/grpc-js normalises all proto field names to camelCase on both
// the server (call.request) and client sides, regardless of keepCase setting.
// Interface names here reflect the camelCase keys actually delivered at runtime.

interface GrpcContractEvent {
  eventId: string;
  ledger: number;
  contractId: string;
  topic: string;
  txHash: string;
  txIndex: number;
  operationIndex: number;
  eventIndex: number;
  payloadJson: string;
  happenedAt: string;
  ledgerHash: string;
}

interface IngestRequest {
  events: GrpcContractEvent[];
}
interface IngestResponse {
  insertedCount: number;
  duplicateCount: number;
  insertedEventIds: string[];
  duplicateEventIds: string[];
}

interface GetEventsRequest {
  fromLedger?: number;
  toLedger?: number;
  contractId?: string;
  topic?: string;
  limit?: number;
  offset?: number;
  afterEventId?: string;
}
interface GrpcStreamEventRecord {
  eventId: string;
  ledger: number;
  contractId: string;
  topic: string;
  txHash: string;
  payloadJson: string;
  happenedAt: string;
  ledgerHash: string;
}
interface GetEventsResponse {
  events: GrpcStreamEventRecord[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string;
}

interface ReplayRequest {
  contractId: string;
  ledger: number;
  fromBlock: number;
  toBlock: number;
}
interface ReplayResponse {
  message: string;
  isReplaying: boolean;
  rowsReplayed: number;
  rowsRemaining: number;
  totalRows: number;
}

interface GetReplayStatusRequest {}
interface GetReplayStatusResponse {
  isReplaying: boolean;
  rowsReplayed: number;
  rowsRemaining: number;
  totalRows: number;
  estimatedCompletion: string;
  startedAt: string;
  contractId: string;
  ledger: number;
}

// ── Service definition loader ─────────────────────────────────────────────────

function loadIndexerServiceDefinition(): grpc.ServiceDefinition {
  const root = protobuf.parse(INDEXER_PROTO_SOURCE).root;
  const packageDefinition = protoLoader.fromJSON(root.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    fluxora: {
      indexer: {
        v1: {
          IndexerService: { service: grpc.ServiceDefinition };
        };
      };
    };
  };
  return loaded.fluxora.indexer.v1.IndexerService.service;
}

const INDEXER_SERVICE_DEFINITION = loadIndexerServiceDefinition();

// ── Token authentication ──────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing-oracle attacks on token
 * validation.  Uses XOR over char codes so the comparison time is O(n) for
 * any two strings of the same length, without early exit on first mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate the `worker_token` metadata entry against the configured secret.
 * Returns a gRPC Status error if authentication fails, or null on success.
 */
function checkWorkerToken(
  metadata: grpc.Metadata,
): grpc.ServiceError | null {
  const values = metadata.get('worker_token');
  const provided = Array.isArray(values) && values.length > 0
    ? String(values[0]).trim()
    : '';

  if (provided === '') {
    return Object.assign(new Error('worker_token metadata is required'), {
      code: grpc.status.UNAUTHENTICATED,
    }) as grpc.ServiceError;
  }

  const expected = (process.env.INDEXER_WORKER_TOKEN ?? 'fluxora-dev-indexer-token').trim();
  if (!timingSafeEqual(provided, expected)) {
    return Object.assign(new Error('worker_token authentication failed'), {
      code: grpc.status.UNAUTHENTICATED,
    }) as grpc.ServiceError;
  }

  return null;
}

// ── RPC handler implementations ───────────────────────────────────────────────

/**
 * IngestContractEvents — transcodes the gRPC request into the same
 * `indexerIngestionService.ingest()` call used by POST /contract-events.
 */
async function handleIngestContractEvents(
  call: grpc.ServerUnaryCall<IngestRequest, IngestResponse>,
  callback: grpc.sendUnaryData<IngestResponse>,
): Promise<void> {
  const authErr = checkWorkerToken(call.metadata);
  if (authErr) { callback(authErr); return; }

  const peer = call.getPeer();
  try {
    const grpcEvents = call.request.events ?? [];

    // Map gRPC wire format → domain type expected by the ingestion service
    const domainEvents = grpcEvents.map((e) => ({
      eventId: e.eventId,
      ledger: e.ledger,
      contractId: e.contractId,
      topic: e.topic,
      txHash: e.txHash,
      txIndex: e.txIndex,
      operationIndex: e.operationIndex,
      eventIndex: e.eventIndex,
      payload: (() => {
        try { return JSON.parse(e.payloadJson) as Record<string, unknown>; }
        catch { return {}; }
      })(),
      happenedAt: e.happenedAt,
      ledgerHash: e.ledgerHash,
    }));

    const result = await indexerIngestionService.ingest(
      { events: domainEvents },
      { actor: peer },
    );

    callback(null, {
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      insertedEventIds: result.insertedEventIds,
      duplicateEventIds: result.duplicateEventIds,
    });
  } catch (err) {
    logger.error('grpc_gateway_ingest_error', undefined, {
      event: 'grpc_gateway_ingest_error',
      peer,
      error: err instanceof Error ? err.message : String(err),
    });
    callback(Object.assign(
      new Error(err instanceof Error ? err.message : 'Ingest failed'),
      { code: grpc.status.INTERNAL },
    ) as grpc.ServiceError);
  }
}

/**
 * GetEvents — transcodes to `indexerIngestionService.getEvents()`,
 * supporting both cursor-based and offset-based pagination.
 */
async function handleGetEvents(
  call: grpc.ServerUnaryCall<GetEventsRequest, GetEventsResponse>,
  callback: grpc.sendUnaryData<GetEventsResponse>,
): Promise<void> {
  const authErr = checkWorkerToken(call.metadata);
  if (authErr) { callback(authErr); return; }

  const peer = call.getPeer();
  try {
    const req = call.request;
    const filter: import('../db/types.js').StreamEventReplayFilter = {
      ...(req.fromLedger && req.fromLedger > 0 ? { fromLedger: req.fromLedger } : {}),
      ...(req.toLedger && req.toLedger > 0 ? { toledger: req.toLedger } : {}),
      ...(req.contractId ? { contractId: req.contractId } : {}),
      ...(req.topic ? { topic: req.topic } : {}),
      ...(req.limit && req.limit > 0 ? { limit: req.limit } : {}),
      ...(req.offset && req.offset > 0 ? { offset: req.offset } : {}),
      ...(req.afterEventId ? { afterEventId: req.afterEventId } : {}),
    };

    const result = await indexerIngestionService.getEvents(filter);

    const events: GrpcStreamEventRecord[] = (result.events ?? []).map((e: import('../db/types.js').StreamEventRecord) => ({
      eventId: e.eventId ?? '',
      ledger: (e as unknown as Record<string, unknown>).ledger as number ?? 0,
      contractId: e.contractId ?? '',
      topic: (e as unknown as Record<string, unknown>).topic as string ?? '',
      txHash: (e as unknown as Record<string, unknown>).tx_hash as string ?? '',
      payloadJson: JSON.stringify((e as unknown as Record<string, unknown>).payload ?? {}),
      happenedAt: (e as unknown as Record<string, unknown>).happened_at as string ?? '',
      ledgerHash: (e as unknown as Record<string, unknown>).ledger_hash as string ?? '',
    }));

    callback(null, {
      events,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      nextCursor: result.nextCursor ?? '',
    });
  } catch (err) {
    logger.error('grpc_gateway_get_events_error', undefined, {
      event: 'grpc_gateway_get_events_error',
      peer,
      error: err instanceof Error ? err.message : String(err),
    });
    callback(Object.assign(
      new Error(err instanceof Error ? err.message : 'GetEvents failed'),
      { code: grpc.status.INTERNAL },
    ) as grpc.ServiceError);
  }
}

/**
 * ReplayEvents — validates via ReplayRequestSchema then delegates to
 * `indexerService.replayEvents()`, mirroring POST /events/replay.
 */
async function handleReplayEvents(
  call: grpc.ServerUnaryCall<ReplayRequest, ReplayResponse>,
  callback: grpc.sendUnaryData<ReplayResponse>,
): Promise<void> {
  const authErr = checkWorkerToken(call.metadata);
  if (authErr) { callback(authErr); return; }

  const peer = call.getPeer();
  try {
    const req = call.request;

    // Validate using the same schema as the HTTP route
    const parsed = ReplayRequestSchema.safeParse({
      contract_id: req.contractId,
      ledger: req.ledger,
      from_block: req.fromBlock,
      to_block: req.toBlock,
    });

    if (!parsed.success) {
      callback(Object.assign(
        new Error(parsed.error.issues.map((i) => i.message).join('; ')),
        { code: grpc.status.INVALID_ARGUMENT },
      ) as grpc.ServiceError);
      return;
    }

    // Fire-and-forget, same as the HTTP route
    indexerService.replayEvents(parsed.data).catch((err: unknown) => {
      logger.error('grpc_gateway_replay_error', undefined, {
        event: 'grpc_gateway_replay_error',
        peer,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const progress = indexerService.getReplayProgress();
    callback(null, {
      message: 'Replay started',
      isReplaying: progress.isReplaying,
      rowsReplayed: progress.rowsReplayed,
      rowsRemaining: progress.rowsRemaining,
      totalRows: progress.totalRows,
    });
  } catch (err) {
    logger.error('grpc_gateway_replay_dispatch_error', undefined, {
      event: 'grpc_gateway_replay_dispatch_error',
      peer,
      error: err instanceof Error ? err.message : String(err),
    });
    callback(Object.assign(
      new Error(err instanceof Error ? err.message : 'ReplayEvents failed'),
      { code: grpc.status.INTERNAL },
    ) as grpc.ServiceError);
  }
}

/**
 * GetReplayStatus — delegates to `indexerService.getReplayProgressExtended()`,
 * mirroring GET /status.
 */
async function handleGetReplayStatus(
  call: grpc.ServerUnaryCall<GetReplayStatusRequest, GetReplayStatusResponse>,
  callback: grpc.sendUnaryData<GetReplayStatusResponse>,
): Promise<void> {
  const authErr = checkWorkerToken(call.metadata);
  if (authErr) { callback(authErr); return; }

  const peer = call.getPeer();
  try {
    const progress = await indexerService.getReplayProgressExtended();
    callback(null, {
      isReplaying: progress.isReplaying,
      rowsReplayed: progress.rowsReplayed,
      rowsRemaining: progress.rowsRemaining,
      totalRows: progress.totalRows,
      estimatedCompletion: progress.estimatedCompletion
        ? (progress.estimatedCompletion instanceof Date
            ? progress.estimatedCompletion.toISOString()
            : String(progress.estimatedCompletion))
        : '',
      startedAt: progress.startedAt
        ? (progress.startedAt instanceof Date
            ? progress.startedAt.toISOString()
            : String(progress.startedAt))
        : '',
      contractId: (progress as unknown as Record<string, unknown>).contractId as string ?? '',
      ledger: (progress as unknown as Record<string, unknown>).ledger as number ?? 0,
    });
  } catch (err) {
    logger.error('grpc_gateway_status_error', undefined, {
      event: 'grpc_gateway_status_error',
      peer,
      error: err instanceof Error ? err.message : String(err),
    });
    callback(Object.assign(
      new Error(err instanceof Error ? err.message : 'GetReplayStatus failed'),
      { code: grpc.status.INTERNAL },
    ) as grpc.ServiceError);
  }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

/**
 * Build (but do not bind/start) the IndexerService gRPC server.
 *
 * Injectable dependencies are accepted for testing; production callers pass
 * nothing and the module-level singletons are used.
 */
export function createGrpcGatewayServer(): grpc.Server {
  const server = new grpc.Server();

  server.addService(INDEXER_SERVICE_DEFINITION, {
    IngestContractEvents: (call: grpc.ServerUnaryCall<IngestRequest, IngestResponse>, cb: grpc.sendUnaryData<IngestResponse>) =>
      void handleIngestContractEvents(call, cb),
    GetEvents: (call: grpc.ServerUnaryCall<GetEventsRequest, GetEventsResponse>, cb: grpc.sendUnaryData<GetEventsResponse>) =>
      void handleGetEvents(call, cb),
    ReplayEvents: (call: grpc.ServerUnaryCall<ReplayRequest, ReplayResponse>, cb: grpc.sendUnaryData<ReplayResponse>) =>
      void handleReplayEvents(call, cb),
    GetReplayStatus: (call: grpc.ServerUnaryCall<GetReplayStatusRequest, GetReplayStatusResponse>, cb: grpc.sendUnaryData<GetReplayStatusResponse>) =>
      void handleGetReplayStatus(call, cb),
  });

  return server;
}

/**
 * Bind and start the gateway server.  Resolves with the bound port on success;
 * rejects if the port is unavailable.
 */
export function startGrpcGatewayServer(
  server: grpc.Server,
  port: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) { reject(err); return; }
        logger.info('grpc_gateway_started', undefined, {
          event: 'grpc_gateway_started',
          port: boundPort,
        });
        resolve(boundPort);
      },
    );
  });
}

/**
 * Gracefully shut down the gateway server with a force-close fallback,
 * mirroring the pattern in src/health/grpcHealth.ts.
 */
export function stopGrpcGatewayServer(
  server: grpc.Server,
  forceShutdownAfterMs = 5_000,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const forceTimer = setTimeout(() => {
      logger.warn('grpc_gateway_force_shutdown', undefined, {
        event: 'grpc_gateway_force_shutdown',
        timeoutMs: forceShutdownAfterMs,
      });
      server.forceShutdown();
      finish();
    }, forceShutdownAfterMs);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    server.tryShutdown((err) => {
      clearTimeout(forceTimer);
      if (err) {
        logger.warn('grpc_gateway_shutdown_error', undefined, {
          event: 'grpc_gateway_shutdown_error',
          error: err.message,
        });
      }
      finish();
    });
  });
}

// ── Feature-flag helper (used by src/index.ts) ────────────────────────────────

/**
 * Returns true when GRPC_GATEWAY_ENABLED is set to true in the environment.
 * Called at startup before `getConfig()` is available to keep the check simple.
 */
export function isGrpcGatewayEnabled(): boolean {
  try {
    return getConfig().grpcGatewayEnabled;
  } catch {
    return false;
  }
}
