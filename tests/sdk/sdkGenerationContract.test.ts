/**
 * Regression tests for the Fluxora SDK Generation Contract.
 *
 * Issue: GitHub #1055 — "Refine SDK generation contract"
 * Refines the contract between `scripts/generate-sdk-ts.mjs` and the on-disk
 * files under `sdk/typescript/`. These tests pin the contract down so future
 * contributors cannot silently revert the refined behavior.
 *
 * Two layers of assertions:
 *  1. Generator-on-disk parity: `node scripts/generate-sdk-ts.mjs --check`
 *     must report zero drift (exit 0).
 *  2. Refined surface: the on-disk files expose the documented safety
 *     refinements (DEFAULT_PAGE_LIMIT/MAX_PAGE_LIMIT/DEFAULT_MAX_PAGES,
 *     inFlight ValidationError guard, hasMorePages/currentCursor/pagesFetched
 *     getters, maxPages cap on autoPaginate, and the idempotency_replayed
 *     envelope alias).
 *
 * @see sdk/typescript/README.md for the human-readable contract.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  FluxoraApiError,
  ValidationError,
  StreamPaginator,
  DEFAULT_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  DEFAULT_MAX_PAGES,
  canonicalizeBody,
  generateIdempotencyKey,
} from '../../sdk/typescript/src/index.js';

import type {
  ResponseMeta,
  ListStreamsParams,
  StreamListResponse,
} from '../../sdk/typescript/src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a one-page response wrapper used by paginator tests.
 *
 * @param streams  streams on this page
 * @param hasMore  whether more pages exist
 * @param cursor   next opaque cursor to forward
 */
function makePage(
  streams: Array<{ id: string }>,
  hasMore: boolean,
  cursor: string | null,
): StreamListResponse {
  return {
    success: true,
    data: {
      streams: streams as unknown as StreamListResponse['data']['streams'],
      has_more: hasMore,
      next_cursor: cursor,
    },
    meta: { timestamp: '2026-01-01T00:00:00Z' },
  };
}

// ── 1. Generator <-> on-disk parity ─────────────────────────────────────────

describe('SDK Generation Contract — generator parity', () => {
  it('node scripts/generate-sdk-ts.mjs --check exits 0 with no drift', () => {
    // Resolve the project root from this test file's location so the spawn
    // works even when vitest is invoked from a subdirectory.
    const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
    const result = spawnSync('node', ['scripts/generate-sdk-ts.mjs', '--check'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      // Surface every line so a regression is debuggable from CI logs.
      const stdout = (result.stdout ?? '').toString();
      const stderr = (result.stderr ?? '').toString();
      throw new Error(
        [
          `Drift check reported a mismatch (exit=${result.status}).`,
          '--- stdout ---',
          stdout,
          '--- stderr ---',
          stderr,
        ].join('\n'),
      );
    }
    expect(result.status).toBe(0);
    expect((result.stdout ?? '')).toMatch(/DRIFT CHECK PASSED/);
    expect((result.stderr ?? '')).not.toMatch(/DRIFT DETECTED/);
  });
});

// ── 2. Refined surface — pagination constants and getters ───────────────────

describe('SDK Generation Contract — pagination safety refinements', () => {
  it('exports the documented page-limit constants with the documented defaults', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(20);
    expect(MIN_PAGE_LIMIT).toBe(1);
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(DEFAULT_MAX_PAGES).toBe(10_000);
  });

  it('ListStreamsParams includes the maxPages field on the refined contract', () => {
    // Pure type-level check via assignment: this would fail to compile if the
    // field were removed.
    const params: ListStreamsParams = {
      limit: 25,
      status: 'active',
      maxPages: 250,
    };
    expect(params.maxPages).toBe(250);
  });

  it('StreamPaginator exposes currentCursor / hasMorePages / pagesFetched getters', async () => {
    const pages: StreamListResponse[] = [
      makePage([{ id: 'a' }], true, 'CURSOR-1'),
      makePage([{ id: 'b' }], false, null),
    ];
    let i = 0;
    const fetchPage = async (): Promise<StreamListResponse> => pages[i++];

    const paginator = new StreamPaginator(fetchPage, { limit: 1 });
    expect(paginator.currentCursor).toBeNull();
    expect(paginator.hasMorePages).toBe(true);
    expect(paginator.pagesFetched).toBe(0);

    const first = await paginator.nextPage();
    expect(first?.map((s) => s.id)).toEqual(['a']);
    expect(paginator.currentCursor).toBe('CURSOR-1');
    expect(paginator.hasMorePages).toBe(true);
    expect(paginator.pagesFetched).toBe(1);

    const second = await paginator.nextPage();
    expect(second?.map((s) => s.id)).toEqual(['b']);
    expect(paginator.hasMorePages).toBe(false);
    expect(paginator.pagesFetched).toBe(2);

    const third = await paginator.nextPage();
    expect(third).toBeNull();
    expect(paginator.pagesFetched).toBe(2); // No fetch on empty tail.
  });

  it('nextPage() rejects with ValidationError when a fetch is already in-flight', async () => {
    // First fetch hangs forever; second nextPage() must reject immediately.
    let resolveFirst!: () => void;
    const fetchPage = (): Promise<StreamListResponse> =>
      new Promise<StreamListResponse>((r) => {
        resolveFirst = () =>
          r(makePage([{ id: 'x' }], false, null));
      });

    const paginator = new StreamPaginator(fetchPage, { limit: 1 });
    const inFlight = paginator.nextPage();
    // Now any concurrent nextPage() must reject with ValidationError.
    await expect(paginator.nextPage()).rejects.toBeInstanceOf(ValidationError);
    // Release the first (so the test doesn't leak promises).
    resolveFirst();
    await inFlight;
  });

  it('autoPaginate() caps iteration by maxPages to prevent infinite loops', async () => {
    // Synthetic page factory — always says "more pages" so a missing cap
    // would loop forever. The cap must stop iteration.
    let calls = 0;
    const fetchPage = async (): Promise<StreamListResponse> => {
      calls += 1;
      return makePage([{ id: `s-${calls}` }], true, `cursor-${calls}`);
    };
    const paginator = new StreamPaginator(fetchPage, { limit: 1, maxPages: 3 });
    const collected: string[] = [];
    for await (const stream of paginator.autoPaginate()) {
      collected.push(stream.id);
    }
    expect(collected.length).toBe(3);
    expect(collected).toEqual(['s-1', 's-2', 's-3']);
    expect(paginator.pagesFetched).toBe(3);
  });
});

// ── 3. Refined surface — idem alias and helpers ──────────────────────────────

describe('SDK Generation Contract — response envelope and helpers', () => {
  it('ResponseMeta accepts both metadata and alias idempotency_replayed flags', () => {
    // Type-level assignment. If either alias is removed, this fails to compile.
    const meta: ResponseMeta = {
      timestamp: '2026-01-01T00:00:00Z',
      requestId: 'req-1',
      idempotency_replayed: true, // primary
      idempotencyReplayed: false, // alias used on envelopes
    };
    expect(meta.idempotency_replayed).toBe(true);
    expect(meta.idempotencyReplayed).toBe(false);
  });

  it('FluxoraApiError preserves statusCode/code/requestId/message for diagnostics', () => {
    const err = new FluxoraApiError(503, 'SERVICE_UNAVAILABLE', 'shutting down', undefined, 'req-xyz');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.requestId).toBe('req-xyz');
    expect(err.message).toContain('503');
    expect(err.name).toBe('FluxoraApiError');
  });

  it('canonicalizeBody is order-independent so fingerprint is deterministic', () => {
    const a = canonicalizeBody({ z: 1, a: { y: 2, b: 3 } });
    const b = canonicalizeBody({ a: { b: 3, y: 2 }, z: 1 });
    expect(a).toBe(b);
  });

  it('generateIdempotencyKey returns a fresh UUID v4 string on each call', () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(b).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
