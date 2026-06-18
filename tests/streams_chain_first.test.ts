/**
 * Chain-first stream creation tests — placeholder.
 *
 * These tests originally exercised the `src/lib/stellar.ts` helper that
 * pre-dated the indexer-driven flow.  That helper was removed and the
 * chain-verification surface is now covered by the indexer ingestion and
 * reorg integration suites.  Keeping this file as a documented skip so the
 * intent is not lost.
 */
import { describe, it } from 'vitest';

describe.skip('POST /api/streams (Chain-First) — legacy', () => {
  it('legacy on-chain verification path was removed in the indexer migration', () => {
    // No-op: tests intentionally skipped.
  });
});
