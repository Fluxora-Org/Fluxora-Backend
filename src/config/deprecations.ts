import type { DeprecatedRoute } from '../middleware/deprecation.js';

/**
 * Machine-readable route retirement registry.
 *
 * Keep dates in ISO-8601 UTC form. The middleware converts them to HTTP-date
 * values for the Sunset response header required by RFC 8594.
 */
export const routeDeprecations: readonly DeprecatedRoute[] = [
  {
    route: '/api/rate-limits/config',
    sunsetDate: '2026-09-30T00:00:00.000Z',
    link: '/docs/api/deprecation-policy.md#current-deprecations',
  },
];
