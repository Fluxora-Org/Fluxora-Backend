### Docker Health Check Tuning

Fluxora's Docker container features parameterised health checks to accommodate different deployment environments.

**Build Arguments (Dockerfile):**
- `HEALTH_INTERVAL` (Default: `30s`): Time between Docker daemon health probes.
- `HEALTH_TIMEOUT` (Default: `5s`): Time before a Docker daemon probe fails.

**Runtime Environment Variables (App Level):**
- `HEALTH_CHECK_INTERVAL_MS` (Default: `30000`): Internal application polling interval.
- `HEALTH_CHECK_TIMEOUT_MS` (Default: `5000`): Maximum time allowed for internal liveness checks.

*Note: Runtime timeout values must be strictly greater than 0.*

## Blue/Green Deployment

Fluxora supports zero-downtime blue/green deployments by running two parallel
application slots (`blue` and `green`) against the same PostgreSQL and Redis
backends. Both slots share the same database schema and are migration-safe:
the `src/db/migrate.ts` guard ensures migrations are idempotent and can be
run concurrently by both slots without conflict.

### Setup

The `docker-compose.yml` includes two services:
- `app-blue` — listens on port 3000, `DEPLOYMENT_SLOT=blue`
- `app-green` — listens on port 3001, `DEPLOYMENT_SLOT=green`

Each service emits an `X-Fluxora-Deployment-Slot` response header on every
HTTP response, enabling a front-side load balancer or the e2e test suite to
verify which slot answered a request during a cutover.

### Cutover Procedure (Manual)

1. **Deploy new code to the inactive slot** (e.g. `app-green`):
   ```bash
   docker-compose up -d --no-deps --build app-green
   ```
2. **Wait for the new slot to become healthy**:
   ```bash
   curl -I http://localhost:3001/health
   # Verify X-Fluxora-Deployment-Slot: green
   ```
3. **Run migrations idempotently** (safe to run on either slot):
   ```bash
   docker-compose exec app-green pnpm run migrate
   ```
4. **Switch load balancer upstream** from port 3000 → 3001.
   - If using `nginx`:
     ```nginx
     upstream fluxora_backend {
       server localhost:3001;  # was 3000
     }
     ```
     Then reload: `nginx -s reload`
   - If using AWS ALB: update the target group to point to the new slot.
5. **Verify traffic is flowing** to the new slot:
   ```bash
   curl -I https://your-api-domain.com/health
   # Verify X-Fluxora-Deployment-Slot: green
   ```
6. **Leave the old slot running** for 10–15 minutes for rollback safety.
7. **Stop the old slot** once confident:
   ```bash
   docker-compose stop app-blue
   ```

### Cutover Procedure (Automated with HAProxy)

If using HAProxy with active health checks:
1. Deploy to the inactive slot and wait for health checks to pass.
2. Update HAProxy config to set the new slot's weight to 100 and the old slot to 0.
3. Reload HAProxy: `haproxy -f /etc/haproxy/haproxy.cfg -sf $(pidof haproxy)`
4. Drain the old slot and stop it after the drain period.

### Rollback Steps

If issues are detected after cutover:
1. **Switch load balancer back** to the old slot (port 3000 if rolling back from 3001).
2. **Verify the old slot is healthy**:
   ```bash
   curl -I http://localhost:3000/health
   ```
3. **Stop the problematic slot**:
   ```bash
   docker-compose stop app-green
   ```
4. **Investigate logs** from the failed slot:
   ```bash
   docker-compose logs app-green
   ```
5. **Fix and redeploy** to the inactive slot before attempting cutover again.

### Migration Safety

Both slots can run migrations concurrently because:
- `src/db/migrate.ts` uses node-pg-migrate's advisory locks to prevent
  concurrent execution of the same migration.
- The `pgmigrations` table tracks applied migrations by name; re-running an
  already-applied migration is a no-op.
- Schema changes are backwards-compatible: additive-only DDL (new columns,
  new tables) is safe; breaking changes require a multi-step deploy.

### Security Notes

- The `DEPLOYMENT_SLOT` env var is read at request time, not module load time,
  so a single container image can serve either slot.
- The header value is sanitized to `[a-z0-9-]+` to prevent header injection.
- Any non-conforming value falls back to `"blue"`.

### Testing

See `tests/app.blueGreen.test.ts` for header presence verification across
200/404/500 responses and DEPLOYMENT_SLOT env var mutation tests.