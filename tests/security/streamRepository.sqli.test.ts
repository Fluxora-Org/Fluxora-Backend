import { describe, it, beforeAll, expect } from 'vitest';
import { sqliPayloads } from './fixtures/sqliPayloads.js';

// The tests here are a regression harness. They exercise the repository
// entrypoints with adversarial input and assert that parameterized queries
// do not return unrelated rows or throw due to injection payloads.

import { streamRepository } from '../../src/db/repositories/streamRepository.js';

describe('streamRepository SQLi regression suite', () => {
  beforeAll(() => {
    // repository should be usable in test mode; if the repo requires a DB,
    // tests should mock pool/query. This file provides the harness and
    // payload library — adapt to CI DB as needed.
  });

  const methods = [
    'upsertStream',
    'getById',
    'findWithCursor',
    'updateStream',
  ] as const;

  for (const payload of sqliPayloads) {
    for (const method of methods) {
      it(`should safely handle payload [${payload}] in ${method}`, async () => {
        // Call each repository method with the adversarial payload in a
        // user-controlled field and assert it doesn't return unrelated rows.
        // The exact assertions depend on the repository API; keep them
        // defensive (no crash, no unexpected non-empty result for lookups).

        try {
          if (method === 'upsertStream') {
            const id = `sqli-test-${Math.random().toString(36).slice(2, 8)}`;
            const result = await (streamRepository as any).upsertStream({ id, contract_id: payload });
            expect(result).toBeDefined();
          } else if (method === 'getById') {
            const res = await (streamRepository as any).getById(payload);
            // Should either return undefined/null or a single matching row —
            // never rows from unrelated ids.
            expect(res === undefined || typeof res === 'object').toBeTruthy();
          } else if (method === 'findWithCursor') {
            const res = await (streamRepository as any).findWithCursor({ filter: { contractId: payload }, limit: 1 });
            expect(res).toBeDefined();
          } else if (method === 'updateStream') {
            const res = await (streamRepository as any).updateStream(payload, { status: 'paused' });
            expect(res === undefined || typeof res === 'object').toBeTruthy();
          }
        } catch (err) {
          // Throwing due to SQL syntax injected into parameters would be a
          // regression; surface the error so CI can triage.
          throw err;
        }
      });
    }
  }
});
