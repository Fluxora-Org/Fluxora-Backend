/**
 * Docs routes — serves the OpenAPI 3.1 spec and Swagger UI.
 *
 * GET /openapi.json  — machine-readable spec (JSON)
 * GET /docs          — Swagger UI (HTML)
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  CACHE DESIGN — intentionally process-lifetime (static spec)            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  Investigation performed 2026-07-28 confirmed that buildOpenApiSpec()   │
 * │  in src/openapi/spec.ts is fully static: it depends only on the         │
 * │  module-level OpenAPI registry and hardcoded Zod schemas. It does NOT   │
 * │  read feature flags (getFlags / isEnabled), environment variables, or   │
 * │  any other runtime-reloadable configuration.                            │
 * │                                                                         │
 * │  Therefore the cache MUST NOT be invalidated on reloadFlags() / SIGHUP  │
 * │  because there is nothing to rebuild — the result is identical every    │
 * │  time. Unnecessary rebuilds would only add latency and GC pressure.     │
 * │                                                                         │
 * │  ⚠️  FUTURE CONTRIBUTORS — if you add feature-flag-gated content to    │
 * │  buildOpenApiSpec() (e.g. conditionally including a route or schema     │
 * │  based on isEnabled()), you MUST:                                       │
 * │    1. Call resetSpecCache() from the reloadFlags() call-site (or from   │
 * │       the SIGHUP handler once one is added).                            │
 * │    2. Update the regression tests in src/routes/docs.test.ts to assert  │
 * │       that reloading flags does invalidate the cache.                   │
 * │    3. Remove the static-spec assertions in that same test file.         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * No authentication is required; the spec itself contains no secrets.
 *
 * @module routes/docs
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiSpec } from '../openapi/spec.js';

export const docsRouter = Router();

// Build once, cache for process lifetime.
//
// The spec is intentionally static (see module-level comment). If
// buildOpenApiSpec() ever reads runtime-reloadable configuration, this cache
// must be invalidated after each successful reload — call resetSpecCache()
// from the reload path and update docs.test.ts accordingly.
let cachedSpec: Record<string, unknown> | null = null;

function getSpec(): Record<string, unknown> {
  if (!cachedSpec) {
    cachedSpec = buildOpenApiSpec();
  }
  return cachedSpec;
}

/** GET /openapi.json — raw OpenAPI 3.1 document */
docsRouter.get('/openapi.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(getSpec());
});

/** GET /docs — Swagger UI */
docsRouter.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    swaggerOptions: { url: '/openapi.json' },
    customSiteTitle: 'Fluxora API Docs',
  }),
);

/** Expose cache-busting helper for tests */
export function resetSpecCache(): void {
  cachedSpec = null;
}
