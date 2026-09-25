/**
 * Docs routes — serves the OpenAPI 3.1 spec and Swagger UI.
 *
 * GET /openapi.json  — machine-readable spec (JSON)
 * GET /docs          — Swagger UI (HTML)
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  CACHE DESIGN — process-lifetime, invalidated on flag reload (#1477)    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  The spec builder in src/openapi/spec.ts is still static: it does not   │
 * │  read flags at build time.                                                │
 * │                                                                          │
 * │  HOWEVER, the docs route now *filters* the served spec to exclude any   │
 * │  path whose enabling feature flag is off (see FLAG_GATED_PATHS below).  │
 * │  That filter does read flags — so the cache is invalidated via          │
 * │  onFlagsReloaded(resetSpecCache), registered at the bottom of this      │
 * │  module.                                                                 │
 * │                                                                          │
 * │  If you add a new flag-gated route:                                      │
 * │    1. Add its spec path + flag name to FLAG_GATED_PATHS.                │
 * │    2. The test in docs.test.ts "FLAG_GATED_PATHS covers every flag-     │
 * │       gated route" will fail until you do.                              │
 * │                                                                          │
 * │  Admin/internal paths are also excluded, unchanged from before.         │
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
import { isEnabled, onFlagsReloaded } from '../config/featureFlags.js';

export const docsRouter = Router();

/**
 * Maps an OpenAPI path (as it appears in the spec) to the feature flag that
 * gates it. Any path listed here is removed from the served spec when its
 * flag is disabled for the `system` requester id (#1477).
 *
 * A test in docs.test.ts asserts every flag-gated route in the app is
 * represented here; add an entry here whenever you gate a new route.
 */
export const FLAG_GATED_PATHS: Record<string, string> = {
  // The GraphQL gateway is mounted conditionally at runtime (#561 in app.ts).
  // It is not currently registered in the OpenAPI spec, but the entry is
  // here so that if/when it is registered, the docs filter will already
  // honour the flag.
  '/api/graphql': 'experimental_graphql_gateway',
};

/** Prefixes that must never appear in public documentation. */
const EXCLUDED_PATH_PREFIXES = ['/api/admin', '/admin', '/internal'];

/** Tag names that must never appear in public documentation. */
const EXCLUDED_TAGS = ['admin', 'indexer', 'webhooks'];

/** Requester id used when evaluating flags for the served spec. */
const SPEC_REQUESTER = 'system';

let cachedSpec: Record<string, unknown> | null = null;

function getSpec(): Record<string, unknown> {
  if (!cachedSpec) {
    const rawSpec = buildOpenApiSpec();
    const spec = JSON.parse(JSON.stringify(rawSpec));

    if (spec.paths) {
      for (const path of Object.keys(spec.paths)) {
        // 1. Always exclude admin/internal paths.
        if (EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
          delete spec.paths[path];
          continue;
        }

        // 2. Exclude flag-gated paths whose flag is off.
        const requiredFlag = FLAG_GATED_PATHS[path];
        if (requiredFlag && !isEnabled(requiredFlag, SPEC_REQUESTER)) {
          delete spec.paths[path];
        }
      }
    }

    if (spec.tags) {
      spec.tags = spec.tags.filter(
        (t: any) => !['admin', 'indexer', 'webhooks'].includes(t.name)
      );
    }

    cachedSpec = spec;
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

/** Expose cache-busting helper for tests. */
export function resetSpecCache(): void {
  cachedSpec = null;
}

// #1477: invalidate the cached spec whenever feature flags reload, since the
// served spec now depends on which flags are enabled.
onFlagsReloaded(resetSpecCache);