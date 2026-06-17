/**
 * Property-based tests for the Redis sliding-window rate limiter.
 *
 * Properties verified:
 *   P1  Count never exceeds limit — after exactly `limit` allowed requests
 *       within a window, every subsequent request is rejected until the
 *       window rolls forward.
 *   P2  Window rollover resets quota — requests made strictly outside an
 *       expired window are always allowed (fresh count = 0).
 *   P3  Monotonic count growth — each allowed call increments count by 1
 *       and decrements remaining by 1; rejected calls leave both unchanged.
 *   P4  Remaining is always non-negative — remaining = limit - count ≥ 0
 *       for every outcome.
 *   P5  Idempotent rejection — once a caller is rate-limited, all further
 *       calls in the same window are also rejected (no phantom re-admission).
 *   P6  Independent keys are isolated — exhausting key A's quota has no
 *       effect on key B's quota.
 *   P7  Limit of 0 always rejects — regardless of window, no request is
 *       ever allowed when limit = 0.
 *   P8  Limit of 1 allows exactly one request per window.
 *   P9  Large burst is fully counted — sending `n` requests atomically
 *       against a limit of `n` yields exactly n allowed and 0 remaining.
 *  P10  Time-windowed correctness — interleaved calls with injected
 *       timestamps spanning two consecutive windows each get their own
 *       independent quota.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryRedisStore,
  slidingWindowCheck,
} from '../../src/middleware/redisSlidingWindow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function store() {
  return new InMemoryRedisStore();
}

/** Generate a random integer in [lo, hi] (inclusive) */
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Run a property assertion `runs` times with fresh random inputs each time */
async function forAll(
  runs: number,
  prop: (trial: number) => Promise<void>
): Promise<void> {
  for (let i = 0; i < runs; i++) {
    await prop(i);
  }
}

const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// P1 — Count never exceeds limit
// ---------------------------------------------------------------------------
describe('P1 — count never exceeds limit', () => {
  it('rejects every request after the limit is reached', async () => {
    await forAll(10, async () => {
      const limit = randInt(1, 20);
      const s = store();
      const key = `rl:p1:${limit}`;
      let now = 1_000_000;

      for (let i = 0; i < limit; i++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        expect(r.allowed).toBe(true);
      }

      // Every subsequent request in the same window must be rejected
      for (let j = 0; j < 5; j++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        expect(r.allowed).toBe(false);
        expect(r.count).toBe(limit);
        expect(r.remaining).toBe(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// P2 — Window rollover resets quota
// ---------------------------------------------------------------------------
describe('P2 — window rollover resets quota', () => {
  it('allows requests again after the window has fully expired', async () => {
    await forAll(10, async () => {
      const limit = randInt(1, 10);
      const s = store();
      const key = `rl:p2:${Math.random()}`;
      const windowMs = randInt(1000, 60_000);
      let now = 1_000_000;

      // Exhaust quota in window 1
      for (let i = 0; i < limit; i++) {
        await slidingWindowCheck(s, key, limit, windowMs, now++);
      }

      // Advance time past the full window
      now += windowMs + 1;

      // First request in window 2 must be allowed
      const r = await slidingWindowCheck(s, key, limit, windowMs, now);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(1);
      expect(r.remaining).toBe(limit - 1);
    });
  });
});

// ---------------------------------------------------------------------------
// P3 — Monotonic count growth / remaining decrements
// ---------------------------------------------------------------------------
describe('P3 — monotonic count growth', () => {
  it('increments count and decrements remaining on each allowed call', async () => {
    await forAll(10, async () => {
      const limit = randInt(3, 30);
      const s = store();
      const key = `rl:p3:${Math.random()}`;
      let now = 2_000_000;
      let expectedCount = 0;

      for (let i = 0; i < limit; i++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        expect(r.allowed).toBe(true);
        expectedCount++;
        expect(r.count).toBe(expectedCount);
        expect(r.remaining).toBe(limit - expectedCount);
      }
    });
  });

  it('rejected calls leave count and remaining unchanged', async () => {
    const limit = 3;
    const s = store();
    const key = 'rl:p3:reject';
    let now = 3_000_000;

    for (let i = 0; i < limit; i++) {
      await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
    }

    const r1 = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
    const r2 = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
    expect(r1.count).toBe(limit);
    expect(r2.count).toBe(limit);
    expect(r1.remaining).toBe(0);
    expect(r2.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P4 — Remaining is always non-negative
// ---------------------------------------------------------------------------
describe('P4 — remaining is always non-negative', () => {
  it('remaining >= 0 for all results regardless of sequence', async () => {
    await forAll(20, async () => {
      const limit = randInt(1, 15);
      const calls = randInt(1, limit * 3);
      const s = store();
      const key = `rl:p4:${Math.random()}`;
      let now = 4_000_000;

      for (let i = 0; i < calls; i++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        expect(r.remaining).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// P5 — Idempotent rejection (no phantom re-admission)
// ---------------------------------------------------------------------------
describe('P5 — idempotent rejection', () => {
  it('once limited, all calls in the same window remain rejected', async () => {
    await forAll(10, async () => {
      const limit = randInt(1, 10);
      const s = store();
      const key = `rl:p5:${Math.random()}`;
      let now = 5_000_000;

      for (let i = 0; i < limit; i++) {
        await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
      }

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          slidingWindowCheck(s, key, limit, WINDOW_MS, now + i)
        )
      );

      for (const r of results) {
        expect(r.allowed).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// P6 — Independent keys are isolated
// ---------------------------------------------------------------------------
describe('P6 — independent keys are isolated', () => {
  it('exhausting one key does not affect another', async () => {
    await forAll(10, async () => {
      const limit = randInt(2, 10);
      const s = store();
      const keyA = `rl:p6:a:${Math.random()}`;
      const keyB = `rl:p6:b:${Math.random()}`;
      let now = 6_000_000;

      // Exhaust keyA
      for (let i = 0; i < limit; i++) {
        await slidingWindowCheck(s, keyA, limit, WINDOW_MS, now++);
      }
      const blocked = await slidingWindowCheck(s, keyA, limit, WINDOW_MS, now++);
      expect(blocked.allowed).toBe(false);

      // keyB must still be fresh
      const ok = await slidingWindowCheck(s, keyB, limit, WINDOW_MS, now);
      expect(ok.allowed).toBe(true);
      expect(ok.count).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// P7 — Limit of 0 always rejects
// ---------------------------------------------------------------------------
describe('P7 — limit of 0 always rejects', () => {
  it('every request is rejected when limit = 0', async () => {
    const s = store();
    const key = 'rl:p7';
    let now = 7_000_000;

    for (let i = 0; i < 10; i++) {
      const r = await slidingWindowCheck(s, key, 0, WINDOW_MS, now++);
      expect(r.allowed).toBe(false);
      expect(r.remaining).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// P8 — Limit of 1 allows exactly one request per window
// ---------------------------------------------------------------------------
describe('P8 — limit of 1 allows exactly one request per window', () => {
  it('first request in each window is allowed, second is not', async () => {
    await forAll(5, async () => {
      const windowMs = randInt(500, 5000);
      const s = store();
      const key = `rl:p8:${Math.random()}`;
      let now = 8_000_000;

      const r1 = await slidingWindowCheck(s, key, 1, windowMs, now);
      expect(r1.allowed).toBe(true);

      const r2 = await slidingWindowCheck(s, key, 1, windowMs, now + 1);
      expect(r2.allowed).toBe(false);

      // After window expires
      const r3 = await slidingWindowCheck(s, key, 1, windowMs, now + windowMs + 1);
      expect(r3.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// P9 — Large burst is fully counted
// ---------------------------------------------------------------------------
describe('P9 — large burst is fully counted', () => {
  it('n requests against limit n yields exactly n allowed and 0 remaining', async () => {
    await forAll(10, async () => {
      const limit = randInt(5, 50);
      const s = store();
      const key = `rl:p9:${Math.random()}`;
      let now = 9_000_000;

      let allowedCount = 0;
      for (let i = 0; i < limit; i++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        if (r.allowed) allowedCount++;
      }

      expect(allowedCount).toBe(limit);

      // Next one is rejected with 0 remaining
      const overflow = await slidingWindowCheck(s, key, limit, WINDOW_MS, now);
      expect(overflow.allowed).toBe(false);
      expect(overflow.remaining).toBe(0);
      expect(overflow.count).toBe(limit);
    });
  });
});

// ---------------------------------------------------------------------------
// P10 — Time-windowed correctness across two consecutive windows
// ---------------------------------------------------------------------------
describe('P10 — time-windowed correctness across two consecutive windows', () => {
  it('calls in adjacent windows each get their own independent quota', async () => {
    await forAll(10, async () => {
      const limit = randInt(3, 10);
      const windowMs = 10_000;
      const s = store();
      const key = `rl:p10:${Math.random()}`;

      const t1Start = 10_000_000;
      const t2Start = t1Start + windowMs; // exactly one window later

      // Fill window 1
      for (let i = 0; i < limit; i++) {
        const r = await slidingWindowCheck(s, key, limit, windowMs, t1Start + i);
        expect(r.allowed).toBe(true);
      }
      const overflow1 = await slidingWindowCheck(s, key, limit, windowMs, t1Start + limit);
      expect(overflow1.allowed).toBe(false);

      // Window 2 starts fresh
      for (let j = 0; j < limit; j++) {
        const r = await slidingWindowCheck(s, key, limit, windowMs, t2Start + j);
        expect(r.allowed).toBe(true);
      }
      const overflow2 = await slidingWindowCheck(s, key, limit, windowMs, t2Start + limit);
      expect(overflow2.allowed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Bonus: result shape invariants
// ---------------------------------------------------------------------------
describe('result shape invariants', () => {
  it('limit field always matches the configured limit', async () => {
    await forAll(15, async () => {
      const limit = randInt(1, 100);
      const s = store();
      const key = `rl:shape:${Math.random()}`;
      let now = 11_000_000;

      for (let i = 0; i < limit + 2; i++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        expect(r.limit).toBe(limit);
      }
    });
  });

  it('count + remaining = limit when allowed; count = limit and remaining = 0 when rejected', async () => {
    await forAll(15, async () => {
      const limit = randInt(1, 20);
      const s = store();
      const key = `rl:balance:${Math.random()}`;
      let now = 12_000_000;

      for (let i = 0; i < limit + 3; i++) {
        const r = await slidingWindowCheck(s, key, limit, WINDOW_MS, now++);
        if (r.allowed) {
          expect(r.count + r.remaining).toBe(limit);
        } else {
          expect(r.count).toBe(limit);
          expect(r.remaining).toBe(0);
        }
      }
    });
  });
});
