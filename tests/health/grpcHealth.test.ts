import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import {
  createGrpcHealthServer,
  startGrpcHealthServer,
  stopGrpcHealthServer,
} from '../../src/health/grpcHealth.js';
import { HealthCheckManager, type HealthChecker } from '../../src/config/health.js';
import { initializeConfig, resetConfig } from '../../src/config/env.js';

// Duplicated from src/health/grpcHealth.ts on purpose: the test builds its
// own client against the well-known, stable grpc.health.v1 proto rather than
// importing any internal from the module under test.
const HEALTH_PROTO_SOURCE = `
syntax = "proto3";
package grpc.health.v1;

message HealthCheckRequest {
  string service = 1;
}

message HealthCheckResponse {
  enum ServingStatus {
    UNKNOWN = 0;
    SERVING = 1;
    NOT_SERVING = 2;
    SERVICE_UNKNOWN = 3;
  }
  ServingStatus status = 1;
}

service Health {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
  rpc Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
}
`;

interface HealthClient extends grpc.Client {
  check(
    request: { service: string },
    callback: (err: grpc.ServiceError | null, response?: { status: string }) => void,
  ): void;
  watch(request: { service: string }): grpc.ClientReadableStream<{ status: string }>;
}

function buildHealthClient(address: string): HealthClient {
  const root = protobuf.parse(HEALTH_PROTO_SOURCE).root;
  const packageDefinition = protoLoader.fromJSON(root.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    grpc: { health: { v1: { Health: new (address: string, creds: grpc.ChannelCredentials) => HealthClient } } };
  };
  return new loaded.grpc.health.v1.Health(address, grpc.credentials.createInsecure());
}

function makeChecker(name: string, check: HealthChecker['check']): HealthChecker {
  return { name, check };
}

async function checkOnce(client: HealthClient): Promise<string> {
  return new Promise((resolve, reject) => {
    client.check({ service: '' }, (err, response) => {
      if (err) reject(err);
      else resolve(response!.status);
    });
  });
}

describe('grpcHealth', () => {
  let server: grpc.Server;
  let client: HealthClient;
  let boundPort: number;
  const clientsToClose: grpc.Client[] = [];

  beforeAll(() => {
    resetConfig();
    process.env.HEALTH_CHECK_INTERVAL_MS = '30';
    initializeConfig();
  });

  afterAll(() => {
    resetConfig();
    delete process.env.HEALTH_CHECK_INTERVAL_MS;
  });

  afterEach(async () => {
    clientsToClose.forEach((c) => c.close());
    clientsToClose.length = 0;
    if (server) {
      await stopGrpcHealthServer(server, 200);
    }
  });

  async function startServerWithManager(manager: HealthCheckManager): Promise<void> {
    server = createGrpcHealthServer(manager);
    boundPort = await startGrpcHealthServer(server, 0);
    client = buildHealthClient(`127.0.0.1:${boundPort}`);
    clientsToClose.push(client);
  }

  describe('Check', () => {
    it('returns SERVING when all dependencies are healthy', async () => {
      const manager = new HealthCheckManager();
      manager.registerChecker(makeChecker('db', async () => ({ latency: 1 })));
      await startServerWithManager(manager);

      await expect(checkOnce(client)).resolves.toBe('SERVING');
    });

    it('returns SERVING when a dependency is degraded (still serving traffic)', async () => {
      const manager = new HealthCheckManager();
      manager.registerChecker(makeChecker('db', async () => ({ latency: 1500, degraded: true })));
      await startServerWithManager(manager);

      await expect(checkOnce(client)).resolves.toBe('SERVING');
    });

    it('returns NOT_SERVING when a dependency is unhealthy', async () => {
      const manager = new HealthCheckManager();
      manager.registerChecker(makeChecker('db', async () => ({ latency: 1, error: 'connection refused' })));
      await startServerWithManager(manager);

      await expect(checkOnce(client)).resolves.toBe('NOT_SERVING');
    });

    it('returns NOT_SERVING (not a gRPC error) when the health manager itself throws', async () => {
      const throwingManager = {
        checkAll: async () => {
          throw new Error('boom');
        },
      } as unknown as HealthCheckManager;
      await startServerWithManager(throwingManager);

      await expect(checkOnce(client)).resolves.toBe('NOT_SERVING');
    });

    it('ignores the service field (single overall status, not per-service)', async () => {
      const manager = new HealthCheckManager();
      manager.registerChecker(makeChecker('db', async () => ({ latency: 1 })));
      await startServerWithManager(manager);

      await expect(
        new Promise((resolve, reject) => {
          client.check({ service: 'some-unknown-service' }, (err, response) => {
            if (err) reject(err);
            else resolve(response!.status);
          });
        }),
      ).resolves.toBe('SERVING');
    });
  });

  describe('Watch', () => {
    it('sends the current status immediately, and again only when it changes', async () => {
      let healthy = true;
      const manager = new HealthCheckManager();
      manager.registerChecker(
        makeChecker('db', async () => (healthy ? { latency: 1 } : { latency: 1, error: 'down' })),
      );
      await startServerWithManager(manager);

      const received: string[] = [];
      const call = client.watch({ service: '' });
      // Expected once we call cancel() (or the server force-closes the
      // stream) — without a listener, grpc-js surfaces it as an unhandled
      // 'error' event on the EventEmitter, failing the test run.
      call.on('error', () => {});
      call.on('data',(resp: { status: string }) => received.push(resp.status));

      // Initial write should arrive quickly, before waiting a full interval.
      await new Promise((r) => setTimeout(r, 15));
      expect(received).toEqual(['SERVING']);

      // Flip status — the next poll tick (interval = 30ms) should push an update.
      healthy = false;
      await new Promise((r) => setTimeout(r, 60));
      expect(received).toEqual(['SERVING', 'NOT_SERVING']);

      // Status stays unhealthy across further polls — no duplicate writes.
      await new Promise((r) => setTimeout(r, 90));
      expect(received).toEqual(['SERVING', 'NOT_SERVING']);

      call.cancel();
    });

    it('stops polling after the client cancels the call', async () => {
      let pollCount = 0;
      const manager = new HealthCheckManager();
      manager.registerChecker(
        makeChecker('db', async () => {
          pollCount++;
          return { latency: 1 };
        }),
      );
      await startServerWithManager(manager);

      const call = client.watch({ service: '' });
      // Expected once we call cancel() (or the server force-closes the
      // stream) — without a listener, grpc-js surfaces it as an unhandled
      // 'error' event on the EventEmitter, failing the test run.
      call.on('error', () => {});
      call.on('data',() => {});
      await new Promise((r) => setTimeout(r, 15)); // let the initial write happen

      call.cancel();
      await new Promise((r) => setTimeout(r, 30)); // let the server's 'cancelled' handler run

      const countAtCancel = pollCount;
      await new Promise((r) => setTimeout(r, 90)); // several more would-be interval ticks

      expect(pollCount).toBe(countAtCancel);
    });
  });

  describe('startGrpcHealthServer / stopGrpcHealthServer', () => {
    it('binds to an ephemeral port and reports the bound port number', async () => {
      const manager = new HealthCheckManager();
      await startServerWithManager(manager);
      expect(boundPort).toBeGreaterThan(0);
    });

    it('shuts down an idle server promptly', async () => {
      const manager = new HealthCheckManager();
      server = createGrpcHealthServer(manager);
      await startGrpcHealthServer(server, 0);

      const start = Date.now();
      await stopGrpcHealthServer(server, 5_000);
      expect(Date.now() - start).toBeLessThan(1_000);
    });

    it('force-shuts-down after the grace period when a call is still open', async () => {
      const manager = new HealthCheckManager();
      manager.registerChecker(makeChecker('db', async () => ({ latency: 1 })));
      await startServerWithManager(manager);

      // Open a Watch stream and never close it client-side.
      const call = client.watch({ service: '' });
      call.on('error', () => {});
      await new Promise<void>((resolve) => {
        call.once('data', () => resolve());
      });

      const start = Date.now();
      await stopGrpcHealthServer(server, 100);
      const elapsed = Date.now() - start;

      // Should resolve via the force-shutdown fallback, not hang indefinitely.
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(1_000);

      // Avoid a redundant stopGrpcHealthServer call in afterEach for this server.
      server = undefined as unknown as grpc.Server;
    });
  });
});
