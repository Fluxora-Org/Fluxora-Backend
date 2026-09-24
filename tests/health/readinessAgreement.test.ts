/**
 * Cross-protocol readiness agreement — issue #1584.
 *
 * `grpc.health.v1.Health.Check` (src/health/grpcHealth.ts) and
 * `GET /health/ready` (src/routes/health.ts) expose the health of the same
 * instance over two protocols. This suite starts **both** surfaces against a
 * single `HealthCheckManager` and asserts they never disagree — including
 * while a dependency is down.
 *
 * The load-bearing assertion is the same report driving both signals:
 *
 *   HTTP 200  ⇔  gRPC SERVING
 *   HTTP 503  ⇔  gRPC NOT_SERVING
 *
 * and, per dependency, the contribution reported by HTTP is exactly the
 * contribution the shared assessment was computed from.
 */

import { afterEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import { healthRouter } from '../../src/routes/health.js';
import { HealthCheckManager, type HealthChecker } from '../../src/config/health.js';
import { assessReadiness } from '../../src/health/readiness.js';
import {
  createGrpcHealthServer,
  startGrpcHealthServer,
  stopGrpcHealthServer,
} from '../../src/health/grpcHealth.js';

// Duplicated from src/health/grpcHealth.ts on purpose: the test builds its own
// client against the well-known, stable grpc.health.v1 proto rather than
// importing an internal from the module under test.
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
}
`;

interface HealthClient extends grpc.Client {
  check(
    request: { service: string },
    callback: (err: grpc.ServiceError | null, response?: { status: string }) => void,
  ): void;
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
    grpc: {
      health: {
        v1: {
          Health: new (address: string, creds: grpc.ChannelCredentials) => HealthClient;
        };
      };
    };
  };
  return new loaded.grpc.health.v1.Health(address, grpc.credentials.createInsecure());
}

async function grpcCheck(client: HealthClient): Promise<string> {
  return new Promise((resolve, reject) => {
    client.check({ service: '' }, (err, response) => {
      if (err) reject(err);
      else resolve(response!.status);
    });
  });
}

const DEPENDENCIES = ['postgres', 'redis', 'stellar_rpc'] as const;

function checkerFor(name: string, down: readonly string[]): HealthChecker {
  return {
    name,
    async check() {
      return down.includes(name)
        ? { latency: 1, error: `dependency_down:${name}` }
        : { latency: 1 };
    },
  };
}

/** Everything needed to observe one instance over both protocols. */
interface Instance {
  app: Express;
  manager: HealthCheckManager;
  client: HealthClient;
  server: grpc.Server;
}

const cleanup: Array<() => Promise<void>> = [];

async function startInstance(
  down: readonly string[],
  configure?: (manager: HealthCheckManager) => void,
): Promise<Instance> {
  const manager = new HealthCheckManager();
  for (const name of DEPENDENCIES) manager.registerChecker(checkerFor(name, down));
  configure?.(manager);

  const app = express();
  app.use(express.json());
  app.locals.healthManager = manager;
  app.use('/health', healthRouter);

  const server = createGrpcHealthServer(manager);
  const port = await startGrpcHealthServer(server, 0);
  const client = buildHealthClient(`127.0.0.1:${port}`);

  cleanup.push(async () => {
    client.close();
    await stopGrpcHealthServer(server, 200);
  });

  return { app, manager, client, server };
}

/** Observe both signals for one instance in a single assertion-friendly tuple. */
async function observeBoth(instance: Instance): Promise<{
  httpStatus: number;
  httpBodyStatus: string;
  httpDependencies: Record<string, string>;
  grpcStatus: string;
}> {
  const res = await request(instance.app).get('/health/ready');
  return {
    httpStatus: res.status,
    httpBodyStatus: res.body.status,
    httpDependencies: res.body.dependencies,
    grpcStatus: await grpcCheck(instance.client),
  };
}

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

describe('HTTP /health/ready and gRPC Check agree (#1584)', () => {
  it('both report ready when every dependency is healthy', async () => {
    const instance = await startInstance([]);
    const observed = await observeBoth(instance);

    expect(observed.httpStatus).toBe(200);
    expect(observed.grpcStatus).toBe('SERVING');
    expect(observed.httpBodyStatus).toBe('healthy');
  });

  it.each([...DEPENDENCIES])(
    'both report identically while %s is down',
    async (downDependency) => {
      const instance = await startInstance([downDependency]);
      const observed = await observeBoth(instance);

      // The two protocols must reach the same conclusion about the instance.
      expect(observed.httpStatus).toBe(503);
      expect(observed.grpcStatus).toBe('NOT_SERVING');
      expect(observed.httpBodyStatus).toBe('unhealthy');

      // Each dependency's contribution is identical across both: the HTTP map
      // is exactly what the shared assessment computed from the same report.
      const report = await instance.manager.checkAll();
      const assessment = assessReadiness(report);
      expect(observed.httpDependencies).toEqual(assessment.dependencies);
      expect(assessment.ready).toBe(false);

      for (const name of DEPENDENCIES) {
        expect(observed.httpDependencies[name]).toBe(
          name === downDependency ? 'unhealthy' : 'healthy',
        );
      }
    },
  );

  it('both stay serving when a dependency is degraded in steady state, within the grace period', async () => {
    // Past the startup window, with a freshly degraded dependency.
    const instance = await startInstance(['redis'], (manager) => {
      Object.defineProperty(manager, 'startTime', { value: Date.now() - 40_000 });
    });
    // A degraded—not unhealthy—dependency: rewrite the check to report latency.
    instance.manager.registerChecker({
      name: 'redis',
      async check() {
        return { latency: 1500, degraded: true };
      },
    });

    const observed = await observeBoth(instance);
    expect(observed.httpStatus).toBe(200);
    expect(observed.grpcStatus).toBe('SERVING');
    expect(observed.httpBodyStatus).toBe('degraded');
  });

  it('both drain the instance once a dependency stays degraded past the grace period', async () => {
    const instance = await startInstance([], (manager) => {
      Object.defineProperty(manager, 'startTime', { value: Date.now() - 80_000 });
    });
    instance.manager.registerChecker({
      name: 'postgres',
      async check() {
        return { latency: 1500, degraded: true };
      },
    });

    // First observation only establishes `degradedSince` (fresh → still within
    // the grace period, so both surfaces are serving here).
    expect(await grpcCheck(instance.client)).toBe('SERVING');

    // Simulate the degradation having persisted past the grace period.
    const lastResults = (instance.manager as unknown as {
      lastResults: Map<string, { degradedSince?: string }>;
    }).lastResults;
    lastResults.get('postgres')!.degradedSince = new Date(Date.now() - 35_000).toISOString();

    const observed = await observeBoth(instance);
    expect(observed.httpStatus).toBe(503);
    expect(observed.grpcStatus).toBe('NOT_SERVING');
    expect(observed.httpBodyStatus).toBe('degraded');
  });

  it('both report not ready when a checker throws', async () => {
    const instance = await startInstance([]);
    instance.manager.registerChecker({
      name: 'postgres',
      async check() {
        throw new Error('boom');
      },
    });

    const observed = await observeBoth(instance);
    expect(observed.httpStatus).toBe(503);
    expect(observed.grpcStatus).toBe('NOT_SERVING');
  });
});
