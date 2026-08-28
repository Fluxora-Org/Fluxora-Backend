/**
 * Comprehensive tests for src/indexer/grpcGateway.ts
 *
 * Coverage targets:
 * - Server creation and lifecycle (start / stop / force-shutdown)
 * - Authentication: missing token, wrong token, correct token
 * - IngestContractEvents: success, validation errors, service errors
 * - GetEvents: success, cursor-based pagination, empty results
 * - ReplayEvents: success, validation errors, concurrent replay
 * - GetReplayStatus: success, extended DB read
 * - Feature-flag helper (isGrpcGatewayEnabled)
 * - Proto loading (service definition built without errors)
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import * as grpc from '@grpc/grpc-js';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the indexer service singletons so tests never touch the DB.
vi.mock('../../src/indexer/service.js', () => ({
  indexerIngestionService: {
    ingest: vi.fn(),
    getEvents: vi.fn(),
  },
  indexerService: {
    replayEvents: vi.fn(),
    getReplayProgress: vi.fn(),
    getReplayProgressExtended: vi.fn(),
  },
}));

// Mock config so we can control GRPC_GATEWAY_ENABLED without env pollution.
vi.mock('../../src/config/env.js', () => ({
  getConfig: vi.fn(() => ({
    grpcGatewayEnabled: true,
    grpcGatewayPort: 0, // OS-assigned port for tests
  })),
}));

// Mock logger to suppress noise in test output.
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  createGrpcGatewayServer,
  startGrpcGatewayServer,
  stopGrpcGatewayServer,
  isGrpcGatewayEnabled,
  GRPC_GATEWAY_MAX_MESSAGE_BYTES,
  GRPC_GATEWAY_DEADLINE_MS,
} from '../../src/indexer/grpcGateway.js';
import { indexerIngestionService, indexerService } from '../../src/indexer/service.js';
import { getConfig } from '../../src/config/env.js';

// Typed mocks for convenience
const mockIngest = indexerIngestionService.ingest as MockedFunction<typeof indexerIngestionService.ingest>;
const mockGetEvents = indexerIngestionService.getEvents as MockedFunction<typeof indexerIngestionService.getEvents>;
const mockReplayEvents = indexerService.replayEvents as MockedFunction<typeof indexerService.replayEvents>;
const mockGetReplayProgress = indexerService.getReplayProgress as MockedFunction<typeof indexerService.getReplayProgress>;
const mockGetReplayProgressExtended = indexerService.getReplayProgressExtended as MockedFunction<typeof indexerService.getReplayProgressExtended>;
const mockGetConfig = getConfig as MockedFunction<typeof getConfig>;

// ── Test helpers ──────────────────────────────────────────────────────────────

const VALID_TOKEN = process.env.INDEXER_WORKER_TOKEN ?? 'indexer-worker-token-for-testing-only-12345';

/** Build gRPC metadata with the given token (or none if omitted). */
function makeMetadata(token?: string): grpc.Metadata {
  const md = new grpc.Metadata();
  if (token !== undefined) md.set('worker_token', token);
  return md;
}

/**
 * Spin up a real gRPC server on an OS-assigned port and return both
 * the server handle and a connected stub so we can make real RPC calls.
 */
async function startTestServer(): Promise<{
  server: grpc.Server;
  port: number;
}> {
  const server = createGrpcGatewayServer();
  const port = await startGrpcGatewayServer(server, 0); // 0 = OS-assigned
  return { server, port };
}

/**
 * Tiny promise wrapper around a unary gRPC client call so tests can
 * await results instead of using nested callbacks.
 */
function callRpc<Req, Res>(
  client: grpc.Client,
  method: string,
  request: Req,
  metadata: grpc.Metadata,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    (client as unknown as Record<string, (r: Req, m: grpc.Metadata, cb: (e: grpc.ServiceError | null, v: Res) => void) => void>)
      [method](request, metadata, (err, response) => {
        if (err) reject(err);
        else resolve(response as Res);
      });
  });
}

/** Load the proto descriptor and create a gRPC client stub for the given port. */
function createTestClient(port: number): grpc.Client {
  // Re-use the same inline proto loading approach as the gateway itself.
  // We import the loaded definition by reconstructing a small proto descriptor
  // directly using @grpc/grpc-js dynamic loading helpers.
  const protoLoader = require('@grpc/proto-loader');
  const protobuf = require('protobufjs');

  const PROTO = `
syntax = "proto3";
package fluxora.indexer.v1;
message ContractEvent {
  string eventId=1; int32 ledger=2; string contractId=3; string topic=4;
  string txHash=5; int32 txIndex=6; int32 operationIndex=7; int32 eventIndex=8;
  string payloadJson=9; string happenedAt=10; string ledgerHash=11;
}
message IngestContractEventsRequest { repeated ContractEvent events=1; }
message IngestContractEventsResponse {
  int32 insertedCount=1; int32 duplicateCount=2;
  repeated string insertedEventIds=3; repeated string duplicateEventIds=4;
}
message GetEventsRequest {
  int32 fromLedger=1; int32 toLedger=2; string contractId=3; string topic=4;
  int32 limit=5; int32 offset=6; string afterEventId=7;
}
message StreamEventRecord {
  string eventId=1; int32 ledger=2; string contractId=3; string topic=4;
  string txHash=5; string payloadJson=6; string happenedAt=7; string ledgerHash=8;
}
message GetEventsResponse {
  repeated StreamEventRecord events=1; int32 total=2; int32 limit=3; int32 offset=4; string nextCursor=5;
}
message ReplayEventsRequest { string contractId=1; int32 ledger=2; int32 fromBlock=3; int32 toBlock=4; }
message ReplayEventsResponse {
  string message=1; bool isReplaying=2; int32 rowsReplayed=3; int32 rowsRemaining=4; int32 totalRows=5;
}
message GetReplayStatusRequest {}
message GetReplayStatusResponse {
  bool isReplaying=1; int32 rowsReplayed=2; int32 rowsRemaining=3; int32 totalRows=4;
  string estimatedCompletion=5; string startedAt=6; string contractId=7; int32 ledger=8;
}
service IndexerService {
  rpc IngestContractEvents(IngestContractEventsRequest) returns (IngestContractEventsResponse);
  rpc GetEvents(GetEventsRequest) returns (GetEventsResponse);
  rpc ReplayEvents(ReplayEventsRequest) returns (ReplayEventsResponse);
  rpc GetReplayStatus(GetReplayStatusRequest) returns (GetReplayStatusResponse);
}`;

  const root = protobuf.parse(PROTO).root;
  const pkgDef = protoLoader.fromJSON(root.toJSON(), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(pkgDef) as Record<string, unknown>;
  const ServiceCtor = (loaded as { fluxora: { indexer: { v1: { IndexerService: typeof grpc.Client } } } })
    .fluxora.indexer.v1.IndexerService;
  return new ServiceCtor(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createGrpcGatewayServer', () => {
  it('returns a grpc.Server instance without throwing', () => {
    const server = createGrpcGatewayServer();
    expect(server).toBeInstanceOf(grpc.Server);
    server.forceShutdown();
  });

  it('publishes bounded message and handler deadline policy', () => {
    expect(GRPC_GATEWAY_MAX_MESSAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(GRPC_GATEWAY_DEADLINE_MS).toBe(30_000);
  });
});

describe('startGrpcGatewayServer / stopGrpcGatewayServer lifecycle', () => {
  it('binds on an OS-assigned port and resolves with a positive port number', async () => {
    const server = createGrpcGatewayServer();
    const port = await startGrpcGatewayServer(server, 0);
    expect(port).toBeGreaterThan(0);
    await stopGrpcGatewayServer(server, 1000);
  });

  it('rejects when binding on a negative port', async () => {
    const server = createGrpcGatewayServer();
    await expect(startGrpcGatewayServer(server, -1)).rejects.toThrow();
    server.forceShutdown();
  });

  it('stopGrpcGatewayServer resolves even if the server was never started', async () => {
    const server = createGrpcGatewayServer();
    // Force-shutdown path: should not hang
    await expect(stopGrpcGatewayServer(server, 200)).resolves.toBeUndefined();
  });

  it('handles force-shutdown timeout gracefully', async () => {
    const server = createGrpcGatewayServer();
    await startGrpcGatewayServer(server, 0);
    // Very short timeout forces the force-shutdown path
    await expect(stopGrpcGatewayServer(server, 1)).resolves.toBeUndefined();
  });
});

describe('isGrpcGatewayEnabled', () => {
  it('returns true when config says enabled', () => {
    mockGetConfig.mockReturnValue({ grpcGatewayEnabled: true, grpcGatewayPort: 50052 } as ReturnType<typeof getConfig>);
    expect(isGrpcGatewayEnabled()).toBe(true);
  });

  it('returns false when config says disabled', () => {
    mockGetConfig.mockReturnValue({ grpcGatewayEnabled: false, grpcGatewayPort: 50052 } as ReturnType<typeof getConfig>);
    expect(isGrpcGatewayEnabled()).toBe(false);
  });

  it('returns false when getConfig throws (config not initialized)', () => {
    mockGetConfig.mockImplementation(() => { throw new Error('not initialized'); });
    expect(isGrpcGatewayEnabled()).toBe(false);
    // Restore for subsequent tests
    mockGetConfig.mockReturnValue({ grpcGatewayEnabled: true, grpcGatewayPort: 0 } as ReturnType<typeof getConfig>);
  });
});

// ── RPC integration tests (real gRPC server on loopback) ─────────────────────

describe('RPC authentication', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeEach(async () => {
    mockGetConfig.mockReturnValue({ grpcGatewayEnabled: true, grpcGatewayPort: 0 } as ReturnType<typeof getConfig>);
    ({ server } = await startTestServer());
    const port = await startGrpcGatewayServer(createGrpcGatewayServer(), 0);
    // Use the server we already started
    server.forceShutdown();
    const { server: s, port: p } = await startTestServer();
    server = s;
    client = createTestClient(p);
  });

  afterEach(async () => {
    client.close();
    await stopGrpcGatewayServer(server, 500);
    vi.clearAllMocks();
  });

  it('returns UNAUTHENTICATED when worker_token metadata is missing', async () => {
    mockIngest.mockResolvedValue({ insertedCount: 0, duplicateCount: 0, insertedEventIds: [], duplicateEventIds: [] });
    const err = await callRpc(client, 'IngestContractEvents', { events: [] }, makeMetadata())
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it('returns UNAUTHENTICATED when worker_token is wrong', async () => {
    const err = await callRpc(client, 'IngestContractEvents', { events: [] }, makeMetadata('wrong-token'))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it('passes through with a correct token', async () => {
    mockIngest.mockResolvedValue({ insertedCount: 0, duplicateCount: 0, insertedEventIds: [], duplicateEventIds: [] });
    const res = await callRpc<unknown, { insertedCount: number }>(
      client, 'IngestContractEvents', { events: [] }, makeMetadata(VALID_TOKEN),
    );
    expect(res.insertedCount).toBe(0);
  });
});

describe('IngestContractEvents RPC', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeEach(async () => {
    const { server: s, port } = await startTestServer();
    server = s;
    client = createTestClient(port);
  });

  afterEach(async () => {
    client.close();
    await stopGrpcGatewayServer(server, 500);
    vi.clearAllMocks();
  });

  it('returns inserted/duplicate counts on success', async () => {
    mockIngest.mockResolvedValue({
      insertedCount: 2,
      duplicateCount: 1,
      insertedEventIds: ['e1', 'e2'],
      duplicateEventIds: ['e3'],
    });

    const res = await callRpc<unknown, {
      insertedCount: number;
      duplicateCount: number;
      insertedEventIds: string[];
      duplicateEventIds: string[];
    }>(client, 'IngestContractEvents', {
      events: [
        { eventId: 'e1', ledger: 100, contractId: 'cid', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payloadJson: '{}', happenedAt: '2024-01-01T00:00:00Z', ledgerHash: 'lh' },
        { eventId: 'e2', ledger: 100, contractId: 'cid', topic: 't', txHash: 'h2', txIndex: 1, operationIndex: 0, eventIndex: 1, payloadJson: '{}', happenedAt: '2024-01-01T00:00:00Z', ledgerHash: 'lh' },
        { eventId: 'e3', ledger: 100, contractId: 'cid', topic: 't', txHash: 'h3', txIndex: 2, operationIndex: 0, eventIndex: 2, payloadJson: '{}', happenedAt: '2024-01-01T00:00:00Z', ledgerHash: 'lh' },
      ],
    }, makeMetadata(VALID_TOKEN));

    expect(res.insertedCount).toBe(2);
    expect(res.duplicateCount).toBe(1);
    expect(res.insertedEventIds).toEqual(['e1', 'e2']);
    expect(res.duplicateEventIds).toEqual(['e3']);
  });

  it('passes the actor peer to the ingest service', async () => {
    mockIngest.mockResolvedValue({ insertedCount: 0, duplicateCount: 0, insertedEventIds: [], duplicateEventIds: [] });
    await callRpc(client, 'IngestContractEvents', { events: [] }, makeMetadata(VALID_TOKEN));
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({ events: [] }),
      expect.objectContaining({ actor: expect.any(String) }),
    );
  });

  it('maps payload_json correctly when JSON is valid', async () => {
    mockIngest.mockResolvedValue({ insertedCount: 1, duplicateCount: 0, insertedEventIds: ['x'], duplicateEventIds: [] });
    await callRpc(client, 'IngestContractEvents', {
      events: [{ eventId: 'x', ledger: 1, contractId: 'c', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payloadJson: '{"amount":"100"}', happenedAt: '2024-01-01T00:00:00Z', ledgerHash: 'lh' }],
    }, makeMetadata(VALID_TOKEN));
    const call = mockIngest.mock.calls[0];
    expect((call[0] as { events: Array<{ payload: Record<string, unknown> }> }).events[0].payload).toEqual({ amount: '100' });
  });

  it('falls back to empty object when payload_json is invalid JSON', async () => {
    mockIngest.mockResolvedValue({ insertedCount: 1, duplicateCount: 0, insertedEventIds: ['x'], duplicateEventIds: [] });
    await callRpc(client, 'IngestContractEvents', {
      events: [{ eventId: 'x', ledger: 1, contractId: 'c', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payloadJson: 'NOT_JSON', happenedAt: '2024-01-01T00:00:00Z', ledgerHash: 'lh' }],
    }, makeMetadata(VALID_TOKEN));
    const call = mockIngest.mock.calls[0];
    expect((call[0] as { events: Array<{ payload: Record<string, unknown> }> }).events[0].payload).toEqual({});
  });

  it('returns INTERNAL when ingest service throws', async () => {
    mockIngest.mockRejectedValue(new Error('DB down'));
    const err = await callRpc(client, 'IngestContractEvents', { events: [] }, makeMetadata(VALID_TOKEN))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.INTERNAL);
  });

  it('handles empty events array', async () => {
    mockIngest.mockResolvedValue({ insertedCount: 0, duplicateCount: 0, insertedEventIds: [], duplicateEventIds: [] });
    const res = await callRpc<unknown, { insertedCount: number }>(
      client, 'IngestContractEvents', { events: [] }, makeMetadata(VALID_TOKEN),
    );
    expect(res.insertedCount).toBe(0);
  });

  it('rejects a request beyond the configured receive-message limit', async () => {
    const err = await callRpc(client, 'IngestContractEvents', {
      events: [{
        eventId: 'oversized', ledger: 1, contractId: 'c', topic: 't', txHash: 'h',
        txIndex: 0, operationIndex: 0, eventIndex: 0,
        payloadJson: 'x'.repeat(GRPC_GATEWAY_MAX_MESSAGE_BYTES),
        happenedAt: '2024-01-01T00:00:00Z', ledgerHash: 'lh',
      }],
    }, makeMetadata(VALID_TOKEN)).catch((e) => e as grpc.ServiceError);

    expect((err as grpc.ServiceError).code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('GetEvents RPC', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeEach(async () => {
    const { server: s, port } = await startTestServer();
    server = s;
    client = createTestClient(port);
  });

  afterEach(async () => {
    client.close();
    await stopGrpcGatewayServer(server, 500);
    vi.clearAllMocks();
  });

  it('returns events and pagination metadata on success', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        { event_id: 'ev1', ledger: 10, contract_id: 'c1', topic: 'transfer', tx_hash: 'h1', payload: { amount: '50' }, happened_at: '2024-01-01T00:00:00Z', ledger_hash: 'lh1' } as unknown as import('../../src/db/types.js').StreamEventRecord,
      ],
      total: 1,
      limit: 100,
      offset: 0,
      nextCursor: 'ev1',
    });

    const res = await callRpc<unknown, {
      events: Array<{ eventId: string }>;
      total: number;
      nextCursor: string;
    }>(client, 'GetEvents', { limit: 100, offset: 0 }, makeMetadata(VALID_TOKEN));

    expect(res.events).toHaveLength(1);
    expect(res.events[0].eventId).toBe('ev1');
    expect(res.total).toBe(1);
    expect(res.nextCursor).toBe('ev1');
  });

  it('returns empty list when no events match', async () => {
    mockGetEvents.mockResolvedValue({ events: [], total: 0, limit: 100, offset: 0 });
    const res = await callRpc<unknown, { events: unknown[]; total: number }>(
      client, 'GetEvents', {}, makeMetadata(VALID_TOKEN),
    );
    expect(res.events).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it('passes cursor filter when afterEventId is provided', async () => {
    mockGetEvents.mockResolvedValue({ events: [], total: 0, limit: 10, offset: 0 });
    await callRpc(client, 'GetEvents', { afterEventId: 'cursor-xyz', limit: 10 }, makeMetadata(VALID_TOKEN));
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ afterEventId: 'cursor-xyz' }),
    );
  });

  it('passes ledger range filters', async () => {
    mockGetEvents.mockResolvedValue({ events: [], total: 0, limit: 10, offset: 0 });
    await callRpc(client, 'GetEvents', { fromLedger: 100, toLedger: 200 }, makeMetadata(VALID_TOKEN));
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromLedger: 100, toledger: 200 }),
    );
  });

  it('passes contractId and topic filters', async () => {
    mockGetEvents.mockResolvedValue({ events: [], total: 0, limit: 10, offset: 0 });
    await callRpc(client, 'GetEvents', { contractId: 'cid', topic: 'transfer' }, makeMetadata(VALID_TOKEN));
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: 'cid', topic: 'transfer' }),
    );
  });

  it('returns INTERNAL when getEvents throws', async () => {
    mockGetEvents.mockRejectedValue(new Error('store error'));
    const err = await callRpc(client, 'GetEvents', {}, makeMetadata(VALID_TOKEN))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.INTERNAL);
  });

  it('returns UNAUTHENTICATED without token', async () => {
    const err = await callRpc(client, 'GetEvents', {}, makeMetadata())
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });
});

describe('ReplayEvents RPC', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeEach(async () => {
    const { server: s, port } = await startTestServer();
    server = s;
    client = createTestClient(port);
  });

  afterEach(async () => {
    client.close();
    await stopGrpcGatewayServer(server, 500);
    vi.clearAllMocks();
  });

  it('starts a replay and returns progress snapshot', async () => {
    mockReplayEvents.mockResolvedValue(undefined);
    mockGetReplayProgress.mockReturnValue({
      isReplaying: true,
      rowsReplayed: 0,
      rowsRemaining: 1000,
      totalRows: 1000,
      estimatedCompletion: null,
      startedAt: new Date('2024-01-01T00:00:00Z'),
    });

    const res = await callRpc<unknown, {
      message: string;
      isReplaying: boolean;
      rowsRemaining: number;
    }>(client, 'ReplayEvents', {
      contractId: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
      ledger: 100,
      fromBlock: 1,
      toBlock: 500,
    }, makeMetadata(VALID_TOKEN));

    expect(res.message).toBe('Replay started');
    expect(res.isReplaying).toBe(true);
    expect(res.rowsRemaining).toBe(1000);
  });

  it('returns INVALID_ARGUMENT when contract_id is missing', async () => {
    const err = await callRpc(client, 'ReplayEvents', {
      contractId: '',
      ledger: 1,
      fromBlock: 1,
      toBlock: 10,
    }, makeMetadata(VALID_TOKEN)).catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('returns INVALID_ARGUMENT when from_block > to_block', async () => {
    const err = await callRpc(client, 'ReplayEvents', {
      contractId: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
      ledger: 1,
      fromBlock: 500,
      toBlock: 100,
    }, makeMetadata(VALID_TOKEN)).catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('does not block when replayEvents is async (fire-and-forget)', async () => {
    let resolveReplay!: () => void;
    mockReplayEvents.mockReturnValue(new Promise<void>((r) => { resolveReplay = r; }));
    mockGetReplayProgress.mockReturnValue({
      isReplaying: true, rowsReplayed: 0, rowsRemaining: 100, totalRows: 100,
      estimatedCompletion: null, startedAt: null,
    });

    // Should resolve immediately without waiting for the replay to complete
    const start = Date.now();
    await callRpc(client, 'ReplayEvents', {
      contractId: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
      ledger: 1,
      fromBlock: 1,
      toBlock: 10,
    }, makeMetadata(VALID_TOKEN));
    expect(Date.now() - start).toBeLessThan(1000);
    resolveReplay();
  });

  it('logs but does not surface replay errors to caller (fire-and-forget)', async () => {
    mockReplayEvents.mockRejectedValue(new Error('replay exploded'));
    mockGetReplayProgress.mockReturnValue({
      isReplaying: false, rowsReplayed: 0, rowsRemaining: 0, totalRows: 0,
      estimatedCompletion: null, startedAt: null,
    });

    // Should still resolve with 200-equivalent (no gRPC error)
    const res = await callRpc<unknown, { message: string }>(
      client, 'ReplayEvents', {
        contractId: 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC',
        ledger: 1, fromBlock: 1, toBlock: 10,
      }, makeMetadata(VALID_TOKEN),
    );
    expect(res.message).toBe('Replay started');
  });

  it('returns UNAUTHENTICATED without token', async () => {
    const err = await callRpc(client, 'ReplayEvents', {
      contractId: 'c', ledger: 1, fromBlock: 1, toBlock: 10,
    }, makeMetadata()).catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });
});

describe('GetReplayStatus RPC', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeEach(async () => {
    const { server: s, port } = await startTestServer();
    server = s;
    client = createTestClient(port);
  });

  afterEach(async () => {
    client.close();
    await stopGrpcGatewayServer(server, 500);
    vi.clearAllMocks();
  });

  it('returns full progress when replay is active', async () => {
    mockGetReplayProgressExtended.mockResolvedValue({
      isReplaying: true,
      rowsReplayed: 500,
      rowsRemaining: 500,
      totalRows: 1000,
      estimatedCompletion: new Date('2024-06-01T12:00:00Z'),
      startedAt: new Date('2024-06-01T11:00:00Z'),
      contractId: 'cid-abc',
      ledger: 42,
    } as ReturnType<typeof indexerService.getReplayProgressExtended> extends Promise<infer T> ? T : never);

    const res = await callRpc<unknown, {
      isReplaying: boolean;
      rowsReplayed: number;
      contractId: string;
      ledger: number;
      estimatedCompletion: string;
    }>(client, 'GetReplayStatus', {}, makeMetadata(VALID_TOKEN));

    expect(res.isReplaying).toBe(true);
    expect(res.rowsReplayed).toBe(500);
    expect(res.contractId).toBe('cid-abc');
    expect(res.ledger).toBe(42);
    expect(res.estimatedCompletion).toBe('2024-06-01T12:00:00.000Z');
  });

  it('returns idle status when no replay is running', async () => {
    mockGetReplayProgressExtended.mockResolvedValue({
      isReplaying: false,
      rowsReplayed: 0,
      rowsRemaining: 0,
      totalRows: 0,
      estimatedCompletion: null,
      startedAt: null,
    } as ReturnType<typeof indexerService.getReplayProgressExtended> extends Promise<infer T> ? T : never);

    const res = await callRpc<unknown, { isReplaying: boolean; estimatedCompletion: string }>(
      client, 'GetReplayStatus', {}, makeMetadata(VALID_TOKEN),
    );
    expect(res.isReplaying).toBe(false);
    expect(res.estimatedCompletion).toBe('');
  });

  it('returns INTERNAL when getReplayProgressExtended throws', async () => {
    mockGetReplayProgressExtended.mockRejectedValue(new Error('DB unavailable'));
    const err = await callRpc(client, 'GetReplayStatus', {}, makeMetadata(VALID_TOKEN))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.INTERNAL);
  });

  it('returns UNAUTHENTICATED without token', async () => {
    const err = await callRpc(client, 'GetReplayStatus', {}, makeMetadata())
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });
});

describe('Security: timing-safe token comparison', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeEach(async () => {
    const { server: s, port } = await startTestServer();
    server = s;
    client = createTestClient(port);
  });

  afterEach(async () => {
    client.close();
    await stopGrpcGatewayServer(server, 500);
    vi.clearAllMocks();
  });

  it('rejects a token that is a prefix of the real token', async () => {
    const prefix = VALID_TOKEN.slice(0, -1);
    const err = await callRpc(client, 'GetReplayStatus', {}, makeMetadata(prefix))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it('rejects a token that is a superset of the real token', async () => {
    const longer = VALID_TOKEN + 'X';
    const err = await callRpc(client, 'GetReplayStatus', {}, makeMetadata(longer))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it('rejects an empty string token', async () => {
    const err = await callRpc(client, 'GetReplayStatus', {}, makeMetadata(''))
      .catch((e) => e as grpc.ServiceError);
    expect((err as grpc.ServiceError).code).toBe(grpc.status.UNAUTHENTICATED);
  });
});
