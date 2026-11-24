import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  matchesIfNoneMatch,
  respondNotModified,
  setValidatorHeaders,
  weakEntityTag,
  type ResourceVersion,
} from './conditionalGet.js';

const version: ResourceVersion = {
  id: 'stream-123',
  updated_at: '2026-11-24T12:30:00.000Z',
};

function createMockResponse(): Response & {
  set: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const set = vi.fn();
  const status = vi.fn().mockReturnThis();
  const end = vi.fn().mockReturnThis();
  return { set, status, end } as unknown as Response & {
    set: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe('conditionalGet', () => {
  describe('weakEntityTag', () => {
    it('creates a weak ETag', () => {
      expect(weakEntityTag(version)).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    });

    it('changes when resource version changes', () => {
      const original = weakEntityTag(version);
      const updated = weakEntityTag({ ...version, updated_at: '2026-11-24T12:31:00.000Z' });

      expect(updated).not.toBe(original);
    });
  });

  describe('matchesIfNoneMatch', () => {
    it('matches the wildcard', () => {
      expect(matchesIfNoneMatch('*', weakEntityTag(version))).toBe(true);
    });

    it('matches weak and strong forms using weak comparison', () => {
      const etag = weakEntityTag(version);
      const strong = etag.replace(/^W\//, '');

      expect(matchesIfNoneMatch(strong, etag)).toBe(true);
      expect(matchesIfNoneMatch(etag, strong)).toBe(true);
    });

    it('matches the tag in a comma-separated list', () => {
      const etag = weakEntityTag(version);

      expect(matchesIfNoneMatch(`"other", ${etag}, "last"`, etag)).toBe(true);
    });

    it('does not match a missing or different ETag', () => {
      expect(matchesIfNoneMatch('"other"', weakEntityTag(version))).toBe(false);
      expect(matchesIfNoneMatch('', weakEntityTag(version))).toBe(false);
    });
  });

  describe('setValidatorHeaders', () => {
    it('sets ETag and Last-Modified', () => {
      const res = createMockResponse();

      setValidatorHeaders(res, version);

      expect(res.set).toHaveBeenCalledWith('ETag', weakEntityTag(version));
      expect(res.set).toHaveBeenCalledWith('Last-Modified', 'Tue, 24 Nov 2026 12:30:00 GMT');
    });
  });

  describe('respondNotModified', () => {
    it('returns false and does not set headers when no If-None-Match is present', () => {
      const req = { headers: {} } as Request;
      const res = createMockResponse();

      expect(respondNotModified(req, res, version)).toBe(false);
      expect(res.set).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns false for a non-matching ETag', () => {
      const req = { headers: { 'if-none-match': '"other"' } } as unknown as Request;
      const res = createMockResponse();

      expect(respondNotModified(req, res, version)).toBe(false);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns true, sets validators, and sends 304 for a weak match', () => {
      const etag = weakEntityTag(version);
      const req = { headers: { 'if-none-match': etag } } as unknown as Request;
      const res = createMockResponse();

      expect(respondNotModified(req, res, version)).toBe(true);
      expect(res.set).toHaveBeenCalledWith('ETag', etag);
      expect(res.set).toHaveBeenCalledWith('Last-Modified', 'Tue, 24 Nov 2026 12:30:00 GMT');
      expect(res.status).toHaveBeenCalledWith(304);
      expect(res.end).toHaveBeenCalledOnce();
    });

    it('handles wildcard and multiple header values', () => {
      const etag = weakEntityTag(version);
      const wildcardReq = { headers: { 'if-none-match': '*' } } as unknown as Request;
      const wildcardRes = createMockResponse();

      expect(respondNotModified(wildcardReq, wildcardRes, version)).toBe(true);
      expect(wildcardRes.status).toHaveBeenCalledWith(304);

      const req = { headers: { 'if-none-match': ['"other"', etag] } } as unknown as Request;
      const res = createMockResponse();

      expect(respondNotModified(req, res, version)).toBe(true);
      expect(res.status).toHaveBeenCalledWith(304);
    });
  });
});
