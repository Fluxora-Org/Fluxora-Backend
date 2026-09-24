/**
 * Dedicated unit test module for src/utils/earlyHints.ts
 *
 * Covers:
 * - clientSupportsEarlyHints: header negotiation (Early-Hints, X-Early-Hints, Accept-Early-Hints)
 * - isEarlyHintsConfigEnabled: configuration toggle inspection
 * - sendEarlyHints safe degradation:
 *   - clients not advertising support receive NO early hints
 *   - clients advertising support receive early hints
 *   - feature disabled via configuration / options
 *   - intermediary writeProcessing exceptions handled safely without crashing
 * - sendEarlyHintsWithBoth safe degradation:
 *   - supporting vs non-supporting client checks
 *
 * @module tests/unit/utils/earlyHints.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import {
  EARLY_HINTS_HEADER,
  clientSupportsEarlyHints,
  isEarlyHintsConfigEnabled,
  sendEarlyHints,
  sendEarlyHintsWithBoth,
  type EarlyHintsConfig,
} from '../../../src/utils/earlyHints.js';

interface MockResponse {
  headersSent: boolean;
  writeProcessing: ReturnType<typeof vi.fn>;
  req?: Partial<Request>;
}

function createMockResponse(initialHeadersSent = false, req?: Partial<Request>): MockResponse {
  return {
    headersSent: initialHeadersSent,
    writeProcessing: vi.fn(),
    req,
  };
}

const BASE_CONFIG: EarlyHintsConfig = {
  baseUrl: '/api/streams',
  hasMore: true,
  nextCursor: 'next_cursor_123',
  queryParams: { status: 'active' },
};

describe('clientSupportsEarlyHints', () => {
  it('identifies EARLY_HINTS_HEADER constant as early-hints', () => {
    expect(EARLY_HINTS_HEADER).toBe('early-hints');
  });

  it('returns false when req is undefined or null', () => {
    expect(clientSupportsEarlyHints(undefined)).toBe(false);
    expect(clientSupportsEarlyHints(null as unknown as Request)).toBe(false);
  });

  it('returns false when req has no headers object', () => {
    expect(clientSupportsEarlyHints({} as Request)).toBe(false);
  });

  it('returns false when no early hints headers are present', () => {
    const req = {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0',
      },
    } as unknown as Request;
    expect(clientSupportsEarlyHints(req)).toBe(false);
  });

  it('recognizes Early-Hints: 1 as supporting', () => {
    const req = {
      headers: { 'early-hints': '1' },
      header: (name: string) => (name.toLowerCase() === 'early-hints' ? '1' : undefined),
    } as unknown as Request;
    expect(clientSupportsEarlyHints(req)).toBe(true);
  });

  it('recognizes Early-Hints: true (case-insensitive) as supporting', () => {
    const req = {
      headers: { 'early-hints': 'True' },
    } as unknown as Request;
    expect(clientSupportsEarlyHints(req)).toBe(true);
  });

  it('recognizes X-Early-Hints: 1 as supporting', () => {
    const req = {
      headers: { 'x-early-hints': '1' },
    } as unknown as Request;
    expect(clientSupportsEarlyHints(req)).toBe(true);
  });

  it('recognizes Accept-Early-Hints: 1 as supporting', () => {
    const req = {
      headers: { 'accept-early-hints': '1' },
    } as unknown as Request;
    expect(clientSupportsEarlyHints(req)).toBe(true);
  });

  it('handles header array values from raw Node IncomingMessage', () => {
    const req = {
      headers: { 'early-hints': ['1', 'true'] },
    } as unknown as IncomingMessage;
    expect(clientSupportsEarlyHints(req)).toBe(true);
  });

  it('rejects Early-Hints: 0 or false', () => {
    expect(
      clientSupportsEarlyHints({ headers: { 'early-hints': '0' } } as unknown as Request)
    ).toBe(false);
    expect(
      clientSupportsEarlyHints({ headers: { 'early-hints': 'false' } } as unknown as Request)
    ).toBe(false);
    expect(
      clientSupportsEarlyHints({ headers: { 'early-hints': 'no' } } as unknown as Request)
    ).toBe(false);
  });
});

describe('isEarlyHintsConfigEnabled', () => {
  const originalEnv = process.env['EARLY_HINTS_ENABLED'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['EARLY_HINTS_ENABLED'] = originalEnv;
    } else {
      delete process.env['EARLY_HINTS_ENABLED'];
    }
  });

  it('returns true when environment variable is not set to false', () => {
    process.env['EARLY_HINTS_ENABLED'] = 'true';
    expect(isEarlyHintsConfigEnabled()).toBe(true);
  });

  it('returns false when environment variable is set to false', () => {
    process.env['EARLY_HINTS_ENABLED'] = 'false';
    expect(isEarlyHintsConfigEnabled()).toBe(false);
  });
});

describe('sendEarlyHints client support & degradation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('skips early hints when client does NOT advertise support via request header', () => {
    const req = {
      headers: { accept: 'application/json' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHints(res as unknown as Response, BASE_CONFIG, req);
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('skips early hints when res.req exists but client does not advertise support', () => {
    const req = {
      headers: { accept: 'application/json' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    // Call without explicit req param; it should fall back to res.req
    sendEarlyHints(res as unknown as Response, BASE_CONFIG);
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('sends early hints when client advertises support via Early-Hints: 1', () => {
    const req = {
      headers: { 'early-hints': '1' },
      header: (name: string) => (name.toLowerCase() === 'early-hints' ? '1' : undefined),
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHints(res as unknown as Response, BASE_CONFIG, req);
    vi.runAllTimers();

    expect(res.writeProcessing).toHaveBeenCalledTimes(1);
    expect(res.writeProcessing).toHaveBeenCalledWith(
      'Link',
      expect.stringContaining('rel="next"')
    );
  });

  it('respects clientSupportsHints: false override even when request header is present', () => {
    const req = {
      headers: { 'early-hints': '1' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHints(
      res as unknown as Response,
      { ...BASE_CONFIG, clientSupportsHints: false },
      req
    );
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('respects clientSupportsHints: true override even when request header is absent', () => {
    const req = {
      headers: {},
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHints(
      res as unknown as Response,
      { ...BASE_CONFIG, clientSupportsHints: true },
      req
    );
    vi.runAllTimers();

    expect(res.writeProcessing).toHaveBeenCalledTimes(1);
  });

  it('skips early hints when enabled: false in config override', () => {
    const req = {
      headers: { 'early-hints': '1' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHints(
      res as unknown as Response,
      { ...BASE_CONFIG, enabled: false },
      req
    );
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('safely handles intermediary error if writeProcessing throws (resilient degradation)', () => {
    const req = {
      headers: { 'early-hints': '1' },
    } as unknown as Request;
    const res = createMockResponse(false, req);
    res.writeProcessing.mockImplementation(() => {
      throw new Error('Broken intermediary socket connection');
    });

    expect(() => {
      sendEarlyHints(res as unknown as Response, BASE_CONFIG, req);
      vi.runAllTimers();
    }).not.toThrow();

    expect(res.writeProcessing).toHaveBeenCalledTimes(1);
  });

  it('skips early hints if headers are already sent', () => {
    const req = {
      headers: { 'early-hints': '1' },
    } as unknown as Request;
    const res = createMockResponse(true, req);

    sendEarlyHints(res as unknown as Response, BASE_CONFIG, req);
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });
});

describe('sendEarlyHintsWithBoth client support & degradation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('skips early hints when client does NOT advertise support', () => {
    const req = {
      headers: { host: 'example.com' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHintsWithBoth(
      res as unknown as Response,
      '/api/streams',
      true,
      'next_123',
      'prev_123',
      undefined,
      req
    );
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });

  it('sends early hints when client advertises support', () => {
    const req = {
      headers: { 'early-hints': '1' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHintsWithBoth(
      res as unknown as Response,
      '/api/streams',
      true,
      'next_123',
      'prev_123',
      undefined,
      req
    );
    vi.runAllTimers();

    expect(res.writeProcessing).toHaveBeenCalledTimes(2);
  });

  it('skips early hints when options.enabled is false', () => {
    const req = {
      headers: { 'early-hints': '1' },
    } as unknown as Request;
    const res = createMockResponse(false, req);

    sendEarlyHintsWithBoth(
      res as unknown as Response,
      '/api/streams',
      true,
      'next_123',
      'prev_123',
      undefined,
      req,
      { enabled: false }
    );
    vi.runAllTimers();

    expect(res.writeProcessing).not.toHaveBeenCalled();
  });
});
