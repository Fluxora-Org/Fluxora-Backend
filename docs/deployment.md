### Docker Health Check Tuning

Fluxora's Docker container features parameterised health checks to accommodate different deployment environments.

**Build Arguments (Dockerfile):**
- `HEALTH_INTERVAL` (Default: `30s`): Time between Docker daemon health probes.
- `HEALTH_TIMEOUT` (Default: `5s`): Time before a Docker daemon probe fails.

**Runtime Environment Variables (App Level):**
- `HEALTH_CHECK_INTERVAL_MS` (Default: `30000`): Internal application polling interval.
- `HEALTH_CHECK_TIMEOUT_MS` (Default: `5000`): Maximum time allowed for internal liveness checks.

*Note: Runtime timeout values must be strictly greater than 0.*