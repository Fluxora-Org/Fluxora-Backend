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

/**
 * Validate the route retirement registry (issue #1437).
 *
 * `createDeprecationMiddleware()` normalizes entries lazily when it is built,
 * but with `routeDeprecations` as static module data an entry with a malformed
 * date or an unsafe header value would crash app construction at best and
 * corrupt response headers at worst. Validate the same invariants explicitly
 * at startup so the failing setting is named in the error.
 *
 * Mirrors the invariants in `src/middleware/deprecation.ts` without importing
 * it, keeping `src/config` free of middleware dependencies.
 */
export function validateDeprecationsConfig(
  routes: readonly DeprecatedRoute[] = routeDeprecations,
): string[] {
  const issues: string[] = [];
  const unsafe = /[\r\n]/;

  routes.forEach((entry, index) => {
    const prefix = `routeDeprecations[${index}]`;

    if (typeof entry.route !== 'string' || !entry.route.startsWith('/')) {
      issues.push(`${prefix}.route must start with / (got ${JSON.stringify(entry.route)})`);
    } else if (unsafe.test(entry.route)) {
      issues.push(`${prefix}.route must not contain CR or LF characters`);
    }

    if (typeof entry.sunsetDate !== 'string' || entry.sunsetDate.trim() === '') {
      issues.push(`${prefix}.sunsetDate must be a non-empty ISO-8601 string`);
    } else if (Number.isNaN(new Date(entry.sunsetDate).getTime())) {
      issues.push(`${prefix}.sunsetDate must be a valid date (got "${entry.sunsetDate}")`);
    } else if (unsafe.test(entry.sunsetDate)) {
      issues.push(`${prefix}.sunsetDate must not contain CR or LF characters`);
    }

    if (entry.link !== undefined) {
      if (typeof entry.link !== 'string' || entry.link.trim() === '') {
        issues.push(`${prefix}.link must be a non-empty string when provided`);
      } else if (unsafe.test(entry.link)) {
        issues.push(`${prefix}.link must not contain CR or LF characters`);
      }
    }
  });

  return issues;
}
