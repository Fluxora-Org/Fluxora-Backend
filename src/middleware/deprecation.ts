import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logging/logger.js';

export interface DeprecatedRoute {
  /** Absolute route path or route prefix to mark as deprecated. */
  route: string;
  /** ISO-8601 date/time for the planned removal. */
  sunsetDate: string;
  /** Optional migration or policy URL exposed through the Link header. */
  link?: string;
}

interface NormalizedDeprecatedRoute extends DeprecatedRoute {
  sunset: Date;
}

const HEADER_VALUE_UNSAFE = /[\r\n]/;

function assertSafeHeaderValue(name: string, value: string): void {
  if (HEADER_VALUE_UNSAFE.test(value)) {
    throw new Error(`${name} must not contain CR or LF characters`);
  }
}

function normalizeRoute(route: string): string {
  if (!route.startsWith('/')) {
    throw new Error('Deprecated route must start with /');
  }

  if (HEADER_VALUE_UNSAFE.test(route)) {
    throw new Error('Deprecated route must not contain CR or LF characters');
  }

  if (route.length > 1 && route.endsWith('/')) {
    return route.slice(0, -1);
  }

  return route;
}

function normalizeEntry(route: string, sunsetDate: string, link?: string): NormalizedDeprecatedRoute {
  assertSafeHeaderValue('Sunset date', sunsetDate);

  const sunset = new Date(sunsetDate);
  if (Number.isNaN(sunset.getTime())) {
    throw new Error(`Invalid sunset date for deprecated route ${route}`);
  }

  if (link) {
    assertSafeHeaderValue('Link URL', link);
  }

  return {
    route: normalizeRoute(route),
    sunsetDate,
    sunset,
    link,
  };
}

function routeMatches(req: Request, route: string): boolean {
  const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
  return path === route || path.startsWith(`${route}/`);
}

function formatLink(link: string): string {
  return `<${link}>; rel="deprecation"`;
}

function appendLinkHeader(res: Response, link: string): void {
  const existing = res.getHeader('Link');
  const next = formatLink(link);

  if (Array.isArray(existing)) {
    res.setHeader('Link', [...existing, next]);
    return;
  }

  if (typeof existing === 'string' && existing.length > 0) {
    res.setHeader('Link', `${existing}, ${next}`);
    return;
  }

  res.setHeader('Link', next);
}

function applyDeprecationHeaders(req: Request, res: Response, entries: NormalizedDeprecatedRoute[]): void {
  if (entries.length === 0) return;

  const earliestSunset = entries.reduce((earliest, entry) =>
    entry.sunset.getTime() < earliest.sunset.getTime() ? entry : earliest,
  );

  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', earliestSunset.sunset.toUTCString());

  for (const entry of entries) {
    if (entry.link) {
      appendLinkHeader(res, entry.link);
    }

    if (entry.sunset.getTime() <= Date.now()) {
      logger.warn('deprecated route is past its sunset date', {
        method: req.method,
        path: req.path,
        route: entry.route,
        sunsetDate: entry.sunsetDate,
        correlationId: req.correlationId,
      });
    }
  }
}

/**
 * Marks a route or route prefix as deprecated and emits RFC 8594 Sunset,
 * Deprecation, and optional migration Link headers without changing behavior.
 */
export function deprecate(route: string, sunsetDate: string, link?: string): RequestHandler {
  const entry = normalizeEntry(route, sunsetDate, link);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (routeMatches(req, entry.route)) {
      applyDeprecationHeaders(req, res, [entry]);
    }

    next();
  };
}

export function createDeprecationMiddleware(entries: readonly DeprecatedRoute[]): RequestHandler {
  const normalized = entries.map((entry) => normalizeEntry(entry.route, entry.sunsetDate, entry.link));

  return (req: Request, res: Response, next: NextFunction): void => {
    const matches = normalized.filter((entry) => routeMatches(req, entry.route));
    applyDeprecationHeaders(req, res, matches);
    next();
  };
}
