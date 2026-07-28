/**
 * Unit tests for the `Watch` RPC handler in src/health/grpcHealth.ts.
 *
 * These tests drive the `Watch` handler directly against a mock stream,
 * rather than via a real gRPC client, so we can deterministically exercise
 * the trickier branches:
 *
 *   1. The "cancel mid-check" race window — stop() firing while
 *      `writeIfChanged` is still awaiting `healthManager.checkAll()`.
 *   2. Timer cleanup on `cancelled` / `error` — verified with fake timers,
 *      not just code inspection.
 *   3. Per-call independence — many simultaneous Watch calls share no
 *      per-call state (no leaked `setInterval`, no shared `lastStatus`).
 *
 * The handler is extracted from `Server#addService` via a one-shot spy
 * around `createGrpcHealthServer(manager)`, so we don't need to bind a port
 * or talk real gRPC.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { createGrpcHealthServer } from '../../src/health/grpcHealth.js';
import { HealthCheckManager, type HealthChecker } from '../../src/config/health.js';
import { getConfig, initializeConfig, resetConfig } from '../../src/config/env.js';

/* ─── Mock Stream ────────────────────────────────────────────────────────── */

/**
 * Loosely-typed shape of the `ServerWritableStream` surface the `Watch`
 * handler actually touches (`write`, `on`). We deliberately avoid the full
 * gRPC stream type here — the production code only depends on these two
 * methods.
 */
interface WatchStream {
  write: (msg: { status: string }) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface MockStreamHandle {
  /** The mock stream itself; cast as `any` to drop into `watch(... )`. */
  stream: WatchStream;
  /** Fires each registered `on()` listener for `event` synchronously. */
  emit: (event: string, ...args: unknown[]) => void;
  /** Every message handed to `stream.write(...)` in order. */
  writes: Array<{ status: string }>;
}

function makeMockStream(): MockStreamHandle {
  const writes: Array<{ status: string }> = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]): void => {
    // Slice so listeners that remove themselves don't mutate while we iterate.
    const arr = (listeners.get(event) ?? []).slice();
    for (const l of arr) {
      l(...args);
    }
  };

  const stream: WatchStream = {
    write: (msg) => {
      writes.push(msg);
    },
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return stream;
    },
  };

  return { stream, emit, writes };
}

/* ─── Watch Handler Capture ──────────────────────────────────────────────── */

type HealthCheckRequest = { service?: string };
type HealthCheckResponse = { status: 'UNKNOWN' | 'SERVING' | 'NOT_SERVING' | 'SERVICE_UNKNOWN' };
type ServerWritableStream = grpc.ServerWritableStream<HealthCheckRequest, HealthCheckResponse>;
type WatchHandler = (call: ServerWritableStream) => void;

/**
 * Invoke `createGrpcHealthServer` and capture the `watch` handler registered
 * via `Server#addService`. The spy is restored before returning so it does
 * not leak into other tests in this worker.
 *
 * The captured handler has an explicit `as unknown as WatchHandler` cast at
 * the assignment site because the production-side `impl.watch` parameter
 * type is a structural superset of what we capture from it; TypeScript's
 * function-parameter contravariance would reject the narrower-WatchStream
 * assignment under strict mode.
 */
function captureWatchHandler(manager: HealthCheckManager): WatchHandler {
  let watch: WatchHandler | null = null;
  const original = grpc.Server.prototype.addService;
  const spy = vi.spyOn(grpc.Server.prototype, 'addService').mockImplementation(function (
    this: grpc.Server,
    _svc: grpc.ServiceDefinition,
    impl: { watch?: WatchHandler },
  ) {
    if (typeof impl.watch === 'function') {
      watch = impl.watch;
    }
    return original.call(this, _svc, impl as unknown as grpc.UntypedServiceImplementation);
  });

  try {
    createGrpcHealthServer(manager);
  } finally {
    spy.mockRestore();
  }

  if (!watch) {
    throw new Error('createGrpcHealthServer did not register a watch handler');
  }
  return watch;
}

/* ─── Deferred Health Checker ────────────────────────────────────────────── */

/**
 * Build a checker whose `check()` returns a promise that stays pending
 * until the test calls `resolve()` via `pending[i].resolve(...)`. Tests use
 * this to pin exactly when `writeIfChanged` resumes after `await
 * resolveServingStatus(...)`.
 */
function makeDeferredChecker(): HealthChecker & {
  pending: Array<{ resolve: (v: { latency: number }) => void }>;
} {
  const pending: Array<{ resolve: (v: { latency: number }) => void }> = [];
  return {
    name: 'test-deferred',
    check: () => {
      let resolve!: (v: { latency: number }) => void;
      // The promise we RETURN is the one whose `resolve` we capture; tests
      // call `pending[i].resolve(value)` to unblock the awaited `checkAll()`.
      const promise = new Promise<{ latency: number }>((r) => {
        resolve = r;
      });
      pending.push({ resolve });
      return promise;
    },
    pending,
  };
}

/**
 * Resolve every queued deferred check with `{ latency: 1 }` (healthy), so
 * the corresponding `writeIfChanged` resumes and observes a status of
 * `SERVING`.
 */
function resolveAllPending(
  checker: { pending: Array<{ resolve: (v: { latency: number }) => void }> },
): void {
  while (checker.pending.length > 0) {
    checker.pending.shift()!.resolve({ latency: 1 });
  }
}

/**
 * Let any pending await chain
 *   writeIfChanged → resolveServingStatus → checkAll → Promise.all → check
 * settle before the test continues with assertions. One
 * `setImmediate` round is enough — Node drains all queued microtasks before
 * firing the next macrotask — so all `await`s in the chain resume inside
 * that single round.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

/* ─── Tests ───────────────────────────────────────────────────────────────── */

describe('grpcHealth Watch — lifecycle unit tests', () => {
  beforeAll(() => {
    resetConfig();
    process.env.HEALTH_CHECK_INTERVAL_MS = '10';
    initializeConfig();
  });

  afterAll(() => {
    resetConfig();
    delete process.env.HEALTH_CHECK_INTERVAL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cancel mid-check (race window)', () => {
    it('drops the in-flight writeIfChanged when cancelled — write() is never invoked', async () => {
      const checker = makeDeferredChecker();
      const manager = new HealthCheckManager();
      manager.registerChecker(checker);
      const watch = captureWatchHandler(manager);

      const call = makeMockStream();
      // `watch` expects a grpc.ServerWritableStream; our mock is a structural
      // subset, so widen at the call site.
      watch(call.stream as unknown as ServerWritableStream);

      // The initial `writeIfChanged()` was kicked off — exactly one check is
      // suspended waiting for the deferred promise.
      expect(checker.pending.length).toBe(1);

      // Cancellation arrives BEFORE the check resolves.
      call.emit('cancelled');

      // Nothing has been written — the only in-flight write is suspended.
      expect(call.writes).toEqual([]);

      // Now resolve the pending check. writeIfChanged's `await` resumes and
      // hits `if (stopped) return;` — the critical post-await guard.
      checker.pending[0]!.resolve({ latency: 1 });
      checker.pending.shift();
      await flushMicrotasks();

      // CRITICAL: even though checkAll() produced valid data, write() was
      // never called.
      expect(call.writes).toEqual([]);
    });
  });

  describe('timer cleanup on cancelled / error (fake timers)', () => {
    it.each(['cancelled', 'error'] as const)(
      'clears the interval after %s — no further writes across many ticks',
      async (event) => {
        // `setImmediate` is intentionally NOT in `toFake` — `flushMicrotasks`
        // relies on Node draining microtasks before firing setImmediate, so
        // we keep it real.
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        });

        const intervalMs = getConfig().healthCheckIntervalMs;
        const checker = makeDeferredChecker();
        const manager = new HealthCheckManager();
        manager.registerChecker(checker);
        const watch = captureWatchHandler(manager);

        const call = makeMockStream();
        watch(call.stream as unknown as ServerWritableStream);

        // Resolve the initial check + drain microtasks so the first write
        // lands — establishes a baseline.
        checker.pending[0]!.resolve({ latency: 1 });
        checker.pending.shift();
        await flushMicrotasks();
        expect(call.writes).toEqual([{ status: 'SERVING' }]);
        const writesBeforeCleanup = call.writes.length;

        // Cancellation / error must clear the interval immediately.
        call.emit(event, event === 'error' ? new Error('client hangup') : undefined);
        await flushMicrotasks();

        // Advance fake time past 10 interval ticks. Any leaked timer would
        // have fired its `writeIfChanged`, and (with a flipped status) would
        // have called `write()` again.
        vi.advanceTimersByTime(intervalMs * 10);

        // Drain microtasks queued by the cancel/error handler. With the
        // interval cleared, no new `writeIfChanged` is scheduled and
        // `pending` is empty by definition — no need to resolve anything.
        await flushMicrotasks();

        expect(call.writes).toEqual([{ status: 'SERVING' }]);
        expect(call.writes.length).toBe(writesBeforeCleanup);
      },
    );
  });

  describe('concurrent Watch calls', () => {
    it('50 concurrent calls each get their own timer and share no per-call state', async () => {
      // Real timers: we never advance time, so the only thing we care about
      // is *registration* — that the implementation never shares a single
      // timer across calls, and that cancelling one does not affect others.
      const checker = makeDeferredChecker();
      const manager = new HealthCheckManager();
      manager.registerChecker(checker);
      const watch = captureWatchHandler(manager);

      // Spy on the global setInterval so we can:
      //   (a) count how many times the handler scheduled a timer, and
      //   (b) capture each returned Timer handle to prove they're all distinct.
      // CRITICAL ordering: snapshot the real setInterval BEFORE installing the
      // spy. Once vi.spyOn replaces `globalThis.setInterval`, capturing it
      // here would capture the spy itself — and calling it from inside the
      // mockImplementation would recurse forever (or hit vitest's recursive
      // spy detection). The real function has to be taken from
      // `globalThis.setInterval` before `vi.spyOn` swaps it out.
      const realSetInterval = globalThis.setInterval;
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const timerHandles: Array<ReturnType<typeof setInterval>> = [];
      setIntervalSpy.mockImplementation((...args: Parameters<typeof setInterval>) => {
        const handle = realSetInterval(...args);
        timerHandles.push(handle);
        return handle;
      });

      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      try {
        const N = 50;
        const calls = Array.from({ length: N }, () => makeMockStream());

        const setCallsBefore = setIntervalSpy.mock.calls.length;
        calls.forEach((c) => watch(c.stream as unknown as ServerWritableStream));
        const setCallsAfter = setIntervalSpy.mock.calls.length;

        // Each watch() registered exactly one setInterval — no sharing.
        expect(setCallsAfter - setCallsBefore).toBe(N);
        // All N timer handles are distinct — no leaked / shared Timer objects.
        expect(new Set(timerHandles).size).toBe(N);
        // N initial writeIfChanged calls are in flight, one per watch.
        expect(checker.pending.length).toBe(N);

        // Cancel ONE call only.
        const victim = 7;
        const clearBefore = clearIntervalSpy.mock.calls.length;
        calls[victim].emit('cancelled');
        const clearAfter = clearIntervalSpy.mock.calls.length;

        expect(clearAfter - clearBefore).toBe(1);
        expect(clearIntervalSpy).toHaveBeenCalledWith(timerHandles[victim]);

        // None of the other 49 timers have been cleared.
        const clearedHandles = new Set(
          clearIntervalSpy.mock.calls.map(
            (args) => args[0] as ReturnType<typeof setInterval>,
          ),
        );
        const unexpectedlyCleared = timerHandles.filter(
          (h, i) => i !== victim && clearedHandles.has(h),
        );
        expect(unexpectedlyCleared).toEqual([]);

        // Resolve all N pending checks. The cancelled call's writeIfChanged
        // will resume but short-circuit at `if (stopped) return;` — proving
        // `stopped` is per-call (closure-scoped). All other N-1 calls will
        // each observe their own fresh `lastStatus = null` and write SERVING
        // exactly once — proving `lastStatus` is also per-call (no leak across
        // calls).
        resolveAllPending(checker);
        await flushMicrotasks();

        expect(calls[victim].writes).toEqual([]);
        const nonCancelledWrites = calls
          .filter((_, i) => i !== victim)
          .map((c) => c.writes);
        expect(nonCancelledWrites).toEqual(
          Array.from({ length: N - 1 }, () => [{ status: 'SERVING' }]),
        );

        // Hygiene: cancel the remaining 49 calls so their intervals are
        // cleared at the test's end. The implementation calls `timer.unref()`
        // so Node can still exit, but the intervals would otherwise keep
        // firing every intervalMs during the worker run, queueing fresh
        // deferred `Promise<{ latency }>` entries on `pending` and pumping
        // background work for no benefit. Cancelling each calls its `stop()`.
        for (let i = 0; i < N; i++) {
          if (i === victim) continue;
          calls[i].emit('cancelled');
        }
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });
  });
});
