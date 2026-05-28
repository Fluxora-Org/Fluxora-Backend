/**
 * Docs routes — serves the OpenAPI 3.1 spec and Swagger UI.
 *
 * GET /openapi.json  — machine-readable spec (JSON)
 * GET /docs          — Swagger UI (HTML)
 *
 * The spec is built once on first request and cached for the process lifetime.
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
