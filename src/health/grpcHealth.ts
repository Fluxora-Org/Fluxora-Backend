/**
 * grpc.health.v1.Health service for Kubernetes-native gRPC health probes
 * (`grpc-health-probe`, kubelet's built-in gRPC liveness/readiness probes).
 *
 * Reuses `HealthCheckManager` — the same dependency-check logic backing the
 * HTTP `/health/ready` route (src/routes/health.ts) — so the two surfaces
 * can never drift: `Check`/`Watch` map `healthy`/`degraded` to `SERVING`
 * and `unhealthy` to `NOT_SERVING`, exactly like `/health/ready`'s 200/503
 * split.
 *
 * The standard proto (see ./health.proto for the human-readable reference)
 * is parsed from an in-memory string rather than read from disk: the
 * Docker production image only ships `dist/`, not `src/`, so a runtime
 * `fs.readFileSync` against `health.proto` would work in dev but fail (or
 * silently resolve to nothing) once deployed.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import { getConfig } from '../config/env.js';
import type { HealthCheckManager, HealthStatus } from '../config/health.js';
import { logger } from '../lib/logger.js';

// Keep in sync with ./health.proto — the canonical, unmodified grpc.health.v1 spec.
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

interface HealthCheckRequest {
  service?: string;
}

interface HealthCheckResponse {
  status: 'UNKNOWN' | 'SERVING' | 'NOT_SERVING' | 'SERVICE_UNKNOWN';
}

function loadHealthServiceDefinition(): grpc.ServiceDefinition {
  const root = protobuf.parse(HEALTH_PROTO_SOURCE).root;
  const packageDefinition = protoLoader.fromJSON(root.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    grpc: { health: { v1: { Health: { service: grpc.ServiceDefinition } } } };
  };
  return loaded.grpc.health.v1.Health.service;
}

const HEALTH_SERVICE_DEFINITION = loadHealthServiceDefinition();

/** healthy/degraded still serve traffic (matches /health/ready's 200 for both). */
function mapStatus(status: HealthStatus): HealthCheckResponse['status'] {
  return status === 'unhealthy' ? 'NOT_SERVING' : 'SERVING';
}

/**
 * Resolve the current status via the real dependency checks (`checkAll()`,
 * not the cached `getLastReport()`) so `Check`/`Watch` reflect live state,
 * same as `/health/ready`. Never throws: any internal failure fails closed
 * to NOT_SERVING, since gRPC health-probe clients only understand the
 * ServingStatus enum, not gRPC error codes.
 */
async function resolveServingStatus(
  healthManager: HealthCheckManager,
): Promise<HealthCheckResponse['status']> {
  try {
    const report = await healthManager.checkAll();
    return mapStatus(report.status);
  } catch (err) {
    logger.error('grpc_health_check_failed', undefined, {
      event: 'grpc_health_check_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return 'NOT_SERVING';
  }
}

/**
 * Build (but do not bind/start) the grpc.health.v1.Health server.
 *
 * `service` on the request is accepted but ignored — this app reports one
 * overall status, not per-service granularity, matching /health/ready's
 * flat status shape.
 */
export function createGrpcHealthServer(healthManager: HealthCheckManager): grpc.Server {
  const server = new grpc.Server();

  server.addService(HEALTH_SERVICE_DEFINITION, {
    check(
      _call: grpc.ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
      callback: grpc.sendUnaryData<HealthCheckResponse>,
    ): void {
      resolveServingStatus(healthManager)
        .then((status) => callback(null, { status }))
        .catch(() => callback(null, { status: 'NOT_SERVING' }));
    },

    watch(call: grpc.ServerWritableStream<HealthCheckRequest, HealthCheckResponse>): void {
      let lastStatus: HealthCheckResponse['status'] | null = null;
      let stopped = false;

      const writeIfChanged = async (): Promise<void> => {
        const status = await resolveServingStatus(healthManager);
        if (stopped) return;
        if (status !== lastStatus) {
          lastStatus = status;
          call.write({ status });
        }
      };

      const intervalMs = getConfig().healthCheckIntervalMs;
      const timer = setInterval(() => {
        void writeIfChanged();
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();

      // Initial status, sent immediately rather than waiting a full interval.
      void writeIfChanged();

      const stop = (): void => {
        stopped = true;
        clearInterval(timer);
      };
      call.on('cancelled', () => {
        stop();
      });
      call.on('error', () => {
        stop();
      });
    },
  });

  return server;
}

/** Bind and start the server. Resolves once bound; rejects on bind failure. */
export function startGrpcHealthServer(server: grpc.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) {
        reject(err);
        return;
      }
      logger.info('grpc_health_server_started', undefined, {
        event: 'grpc_health_server_started',
        port: boundPort,
      });
      resolve(boundPort);
    });
  });
}

/**
 * Gracefully shut down the gRPC health server, mirroring the force-close
 * fallback pattern in shutdown.ts's gracefulShutdown(): if in-flight calls
 * (e.g. an open Watch stream) don't drain within `forceShutdownAfterMs`,
 * force-close instead of hanging the process shutdown indefinitely.
 */
export function stopGrpcHealthServer(server: grpc.Server, forceShutdownAfterMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const forceTimer = setTimeout(() => {
      logger.warn('grpc_health_server_force_shutdown', undefined, {
        event: 'grpc_health_server_force_shutdown',
        timeoutMs: forceShutdownAfterMs,
      });
      server.forceShutdown();
      finish();
    }, forceShutdownAfterMs);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    server.tryShutdown((err) => {
      clearTimeout(forceTimer);
      if (err) {
        logger.warn('grpc_health_server_shutdown_error', undefined, {
          event: 'grpc_health_server_shutdown_error',
          error: err.message,
        });
      }
      finish();
    });
  });
}
