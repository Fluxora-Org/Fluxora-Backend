### Docker Health Check Tuning

Fluxora's Docker container features parameterised health checks to accommodate different deployment environments.

**Build Arguments (Dockerfile):**
- `HEALTH_INTERVAL` (Default: `30s`): Time between Docker daemon health probes.
- `HEALTH_TIMEOUT` (Default: `5s`): Time before a Docker daemon probe fails.

**Runtime Environment Variables (App Level):**
- `HEALTH_CHECK_INTERVAL_MS` (Default: `30000`): Internal application polling interval.
- `HEALTH_CHECK_TIMEOUT_MS` (Default: `5000`): Maximum time allowed for internal liveness checks.

*Note: Runtime timeout values must be strictly greater than 0.*

### gRPC Health Check (Kubernetes-native probes)

Kubernetes' built-in gRPC probes (`livenessProbe.grpc` / `readinessProbe.grpc`, and the standalone `grpc-health-probe` binary) speak the standard `grpc.health.v1.Health` protocol rather than plain HTTP. Fluxora can expose this alongside the existing HTTP `/health` endpoints, on a separate port so it never competes with API traffic.

**Runtime Environment Variables (App Level):**
- `GRPC_HEALTH_ENABLED` (Default: `false`): Enables the gRPC health service.
- `GRPC_HEALTH_PORT` (Default: `50051`): Port the gRPC health service binds to. Must differ from `PORT` (the HTTP port).

The service reuses the exact same `HealthCheckManager` dependency checks as `/health/ready` (`src/config/health.ts`) — it does not re-implement or duplicate any check logic, so the two surfaces cannot drift out of sync. `healthy` and `degraded` both map to `SERVING` (matching `/health/ready`'s 200 response for both statuses); `unhealthy` maps to `NOT_SERVING`.

**Security note:** like the internal HTTP endpoints documented above, the gRPC health port is intentionally unauthenticated — Kubernetes probes and `grpc-health-probe` don't send credentials. This port must **not** be exposed outside the cluster network (no public LoadBalancer/Ingress); bind it only to a `ClusterIP` service or rely on the pod's default internal-only networking.

**Example — `grpc-health-probe` (manual check):**
```bash
grpc-health-probe -addr=localhost:50051
```

**Example — Kubernetes probe configuration:**
```yaml
livenessProbe:
  grpc:
    port: 50051
readinessProbe:
  grpc:
    port: 50051
  periodSeconds: 10
```