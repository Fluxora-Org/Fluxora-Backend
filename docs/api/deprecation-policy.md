# API Deprecation Policy

Fluxora uses response headers and published documentation to give API consumers a predictable route retirement process.

## Timeline

1. Announce the deprecation in release notes, the changelog, and this policy.
2. Add the route to `src/config/deprecations.ts` with an ISO-8601 UTC sunset date and migration link.
3. Serve the deprecated route for at least 90 days, or one major release cycle, whichever is longer.
4. Keep the route behavior-compatible during the deprecation window except for urgent security fixes.
5. Remove the route only after the sunset date has passed and the migration guide is available.

## Response Headers

Deprecated routes include these headers on every matching response:

```http
Deprecation: true
Sunset: Wed, 30 Sep 2026 00:00:00 GMT
Link: </docs/api/deprecation-policy.md#current-deprecations>; rel="deprecation"
```

`Sunset` is formatted as an HTTP date as required by RFC 8594. `Deprecation` is a machine-readable signal that the route is scheduled for removal. `Link` points to migration details when a route-specific guide exists.

## Consumer Guide

Clients should treat `Deprecation: true` as an action-required signal. Store or surface the `Sunset` date, follow the `Link` migration guide, and move traffic before the sunset date. Deprecated routes remain served during the window, including after the sunset date if removal has not shipped yet, but callers should not depend on that grace period.

## Security Notes

Deprecation metadata is configured in source control and validated before middleware registration. Header values containing carriage returns or line feeds are rejected to prevent response-splitting attacks. The middleware logs only method, path, configured route, sunset date, and correlation ID when a route is past sunset.

## Current Deprecations

| Route | Sunset date | Replacement |
| --- | --- | --- |
| `/api/rate-limits/config` | `2026-09-30T00:00:00.000Z` | Use deployment-managed rate-limit configuration and `GET /api/rate-limits` for caller status. |
