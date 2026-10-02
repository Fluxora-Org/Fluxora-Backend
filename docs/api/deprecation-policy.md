# API Deprecation Policy

Fluxora uses response headers and published documentation to give API consumers a predictable route retirement process.

## Minimum Notice Period

Deprecated routes must carry a sunset date that is **at least 90 days** in the future from the moment the deprecation is registered. This is enforced at two levels:

- **CI** — `pnpm run check:deprecations` (which calls `assertDeprecationSunsetDates`) fails the pipeline if any entry has a `SHORT_NOTICE` or `PAST_SUNSET` violation.
- **Code** — `findDeprecationViolations` returns a `SHORT_NOTICE` violation for any entry whose `sunset − now < 90 days`. The violation message states exactly how many days are given so the author knows by how much to extend the date.

The 90-day window may be extended to one full major release cycle when a major version bump is planned — whichever period is longer applies.

## Timeline

1. Announce the deprecation in release notes, the [API changelog](./changelog.md#deprecations), and this policy.
2. Add the route to `src/config/deprecations.ts` with an ISO-8601 UTC sunset date (≥ 90 days out) and migration link.
3. Serve the deprecated route for at least 90 days, or one major release cycle, whichever is longer.
4. Keep the route behavior-compatible during the deprecation window except for urgent security fixes.
5. After the sunset date, replace the live handler with `retiredRoute()` — do not leave the handler in place silently.

## Response Headers

Deprecated routes include these headers on every matching response:

```http
Deprecation: true
Sunset: Wed, 30 Sep 2026 00:00:00 GMT
Link: </docs/api/deprecation-policy.md#current-deprecations>; rel="deprecation"
```

`Sunset` is formatted as an HTTP date as required by RFC 8594. `Deprecation` is a machine-readable signal that the route is scheduled for removal. `Link` points to migration details when a route-specific guide exists.

## Retired Endpoints

Once a route has passed its sunset date and is formally removed, its handler is replaced with `retiredRoute(sunsetDate, link?)` from `src/middleware/deprecation.ts`. This returns:

- **HTTP 410 Gone** — a defined status code, not a generic 404 or 500.
- `Sunset` header — the last-known removal date retained for client diagnostics.
- `Link` header — the migration guide URL (if one was registered).
- JSON body `{ "error": "ENDPOINT_RETIRED", "message": "...", "link": "..." }`.

Example usage:

```ts
// After 2026-09-30 — swap the live handler for retiredRoute()
router.all(
  '/api/rate-limits/config',
  retiredRoute(
    '2026-09-30T00:00:00.000Z',
    '/docs/api/deprecation-policy.md#current-deprecations',
  ),
);
```

## Observability

Deprecated-route hits are tracked by the `fluxora_deprecated_route_hits_total` Prometheus counter (label: `route`). This makes it possible to:

- Build a dashboard showing which deprecated routes still receive traffic.
- Alert when traffic to a soon-to-retire route is non-zero close to the sunset date.
- Confirm that client migration is complete before the endpoint is retired.

For routes past their sunset date the middleware also emits a structured `logger.warn` with `event: 'route.sunset.past'` to surface the overdue status in log aggregation.

## Consumer Guide

Clients should treat `Deprecation: true` as an action-required signal. Store or surface the `Sunset` date, follow the `Link` migration guide, and move traffic before the sunset date. Deprecated routes remain served during the window, including after the sunset date if removal has not shipped yet, but callers should not depend on that grace period.

## Security Notes

Deprecation metadata is configured in source control and validated before middleware registration. Header values containing carriage returns or line feeds are rejected to prevent response-splitting attacks. The middleware logs only method, path, configured route, sunset date, and correlation ID when a route is past sunset.

## Current Deprecations

| Route | Sunset date | Replacement |
| --- | --- | --- |
| `/api/rate-limits/config` | `2027-03-31T00:00:00.000Z` | Use deployment-managed rate-limit configuration and `GET /api/rate-limits` for caller status. |
