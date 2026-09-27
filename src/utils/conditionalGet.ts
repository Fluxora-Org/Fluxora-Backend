/**
 * HTTP cache-validator helpers (RFC 7232) shared by resource routes.
 *
 * Resources are fingerprinted from their id and last-modified timestamp into a
 * weak ETag, so any route that exposes a row with `id` + `updated_at` can emit
 * validators and answer conditional GETs with 304 Not Modified.
 *
 * @module utils/conditionalGet
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';

/** Minimal shape needed to derive cache validators for a resource. */
export type ResourceVersion = {
  id: string;
  updated_at: string;
};

export function weakEntityTag(version: ResourceVersion): string {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${version.id}:${version.updated_at}`)
    .digest('base64url');
  return `W/"${fingerprint}"`;
}

/** Set `ETag` and `Last-Modified` for the given resource version. */
export function setValidatorHeaders(res: Response, version: ResourceVersion): void {
  res.set('ETag', weakEntityTag(version));
  res.set('Last-Modified', new Date(version.updated_at).toUTCString());
}

/**
 * RFC 7232 §3.2 weak comparison for If-None-Match.
 *
 * The `*` wildcard matches any current representation.
 * Otherwise the field value is a comma-separated list of entity-tags and the
 * recipient uses the weak comparison function (strip `W/` prefix before
 * character-for-character comparison of the opaque-tag, including DQUOTES).
 *
 * @param ifNoneMatch - raw value of the If-None-Match request header
 * @param etag - the server-computed ETag for the current representation
 * @returns `true` when any entry in the list matches
 */
export function matchesIfNoneMatch(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;

  const normalize = (tag: string): string => tag.replace(/^W\//i, '');
  const normalizedEtag = normalize(etag);

  return trimmed
    .split(',')
    .map((t) => normalize(t.trim()))
    .some((t) => t === normalizedEtag);
}

/**
 * Answer a conditional GET. When the request's If-None-Match matches the
 * current version, sends `304 Not Modified` with validators and returns
 * `true`; the caller must then stop handling the request.
 */
export function respondNotModified(req: Request, res: Response, version: ResourceVersion): boolean {
  const rawIfNoneMatch = req.headers['if-none-match'];
  if (rawIfNoneMatch === undefined) return false;

  const header = Array.isArray(rawIfNoneMatch) ? rawIfNoneMatch.join(', ') : rawIfNoneMatch;
  if (!matchesIfNoneMatch(header, weakEntityTag(version))) return false;

  setValidatorHeaders(res, version);
  res.status(304).end();
  return true;
}
