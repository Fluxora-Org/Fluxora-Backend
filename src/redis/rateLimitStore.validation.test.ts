/**
 * Input-validation coverage for `src/redis/rateLimitStore.ts` (issue #1785).
 *
 * `rateLimitStore.ts` is the store behind the rate limiter, so malformed input
 * that reaches it is a data bug waiting to happen: an unbounded key or a
 * garbage window is written straight into Redis (`PEXPIRE windowMs`) or into
 * the in-memory bucket map. These tests pin the validation contract:
 *
 *   - malformed, empty and oversized input is rejected with a **typed**
 *     `RateLimitInputError` carrying a machine-readable `field` + `rule`, so
 *     the caller can tell *why* the input was rejected;
 *   - rejection happens **before any state is written** — no bucket, no Redis
 *     command, no key;
 *   - valid input is unaffected, including the configured boundary values.
 *
 * The tests assert the *error contract*, not incidental message text: they
 * check `instanceof RateLimitInputError`, `.field`, `.rule` and `.name`, which
 * is exactly what a caller would branch on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HybridStore,
    InMemoryStore,
    MAX_RATE_LIMIT_KEY_LENGTH,
    MIN_RATE_LIMIT_WINDOW_MS,
    RateLimitInputError,
    SlidingWindowStore,
} from './rateLimitStore.js';
import { MAX_WINDOW_MS } from '../config/rateLimits.js';
import { FakeRedisClient } from './__test__/fakeRedisClient.js';
import type { RateLimitStore } from '../types/rateLimit.js';

const VALID_KEY = 'v1:ip:127.0.0.1:api_streams';
/** A small but valid window (the production floor is 1000 ms). */
const VALID_WINDOW_MS = 1_000;

/** Assert `promise` rejects with a typed error for `field`/`rule`. */
async function expectInputError(
    promise: Promise<unknown>,
    field: 'key' | 'windowMs',
    rule?: string
): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(RateLimitInputError);
    await promise.catch((err: unknown) => {
        const error = err as RateLimitInputError;
        expect(error.name).toBe('RateLimitInputError');
        expect(error.field).toBe(field);
        expect(error.rule).toBeTruthy();
        if (rule) expect(error.rule).toBe(rule);
    });
}

// ---------------------------------------------------------------------------
// Malformed / empty / oversized keys
// ---------------------------------------------------------------------------

describe('rateLimitStore — key input validation', () => {
    let memory: InMemoryStore;
    let client: FakeRedisClient;
    let sliding: SlidingWindowStore;

    beforeEach(() => {
        memory = new InMemoryStore();
        client = new FakeRedisClient();
        sliding = new SlidingWindowStore(client);
    });

    const malformedKeys: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['null', null],
        ['number', 42],
        ['object', { toString: () => 'x' }],
        ['array', []],
        ['boolean', true],
    ];

    it.each(malformedKeys)(
        'rejects a non-string key (%s) with field="key"',
        async (_label: string, key: unknown) => {
            await expectInputError(memory.increment(key as string, VALID_WINDOW_MS, 10), 'key');
            await expectInputError(memory.getCount(key as string, VALID_WINDOW_MS), 'key');
            await expectInputError(sliding.increment(key as string, VALID_WINDOW_MS, 10), 'key');
            await expectInputError(sliding.getCount(key as string, VALID_WINDOW_MS), 'key');
        }
    );

    it.each([
        ['empty string', ''],
        ['whitespace only', '   '],
        ['tab/newline only', '\t\n'],
    ])('rejects an empty key (%s)', async (_label: string, key: string) => {
        await expectInputError(memory.increment(key, VALID_WINDOW_MS, 10), 'key');
        await expectInputError(sliding.getCount(key, VALID_WINDOW_MS), 'key');
    });

    it('rejects a key larger than the maximum length', async () => {
        const oversized = 'k'.repeat(MAX_RATE_LIMIT_KEY_LENGTH + 1);
        await expectInputError(memory.increment(oversized, VALID_WINDOW_MS, 10), 'key');
        await expectInputError(sliding.increment(oversized, VALID_WINDOW_MS, 10), 'key');
    });

    it('accepts a key exactly at the maximum length (boundary)', async () => {
        const atMax = 'k'.repeat(MAX_RATE_LIMIT_KEY_LENGTH);
        const result = await memory.increment(atMax, VALID_WINDOW_MS, 10);
        expect(result.count).toBe(1);
    });

    it('does not mutate in-memory state when a key is rejected', async () => {
        await expectInputError(memory.increment('', VALID_WINDOW_MS, 10), 'key');
        await expectInputError(
            memory.increment('k'.repeat(MAX_RATE_LIMIT_KEY_LENGTH + 1), VALID_WINDOW_MS, 10),
            'key'
        );
        // No bucket was created for the rejected keys — a subsequent valid call
        // starts counting from 1, proving the rejections wrote nothing.
        expect((await memory.getCount(VALID_KEY, VALID_WINDOW_MS)).count).toBe(0);
        expect((await memory.increment(VALID_KEY, VALID_WINDOW_MS, 10)).count).toBe(1);
    });

    it('issues no Redis command when a key is rejected', async () => {
        const zcountSpy = vi.spyOn(client, 'zcount');
        const multiSpy = vi.spyOn(client, 'multi');

        await expectInputError(sliding.increment('', VALID_WINDOW_MS, 10), 'key');
        await expectInputError(
            sliding.increment('k'.repeat(MAX_RATE_LIMIT_KEY_LENGTH + 1), VALID_WINDOW_MS, 10),
            'key'
        );
        await expectInputError(sliding.getCount('', VALID_WINDOW_MS), 'key');

        expect(zcountSpy).not.toHaveBeenCalled();
        expect(multiSpy).not.toHaveBeenCalled();
        expect(client.getSortedSetKeys()).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Out-of-range / malformed windows
// ---------------------------------------------------------------------------

describe('rateLimitStore — windowMs input validation', () => {
    let memory: InMemoryStore;
    let client: FakeRedisClient;
    let sliding: SlidingWindowStore;

    beforeEach(() => {
        memory = new InMemoryStore();
        client = new FakeRedisClient();
        sliding = new SlidingWindowStore(client);
    });

    const malformedWindows: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['null', null],
        ['string', '60000'],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['float', 1500.5],
        ['zero', 0],
        ['negative', -1],
        ['below floor', MIN_RATE_LIMIT_WINDOW_MS - 1],
        ['above ceiling', MAX_WINDOW_MS + 1],
    ];

    it.each(malformedWindows)(
        'rejects an invalid window (%s) with field="windowMs"',
        async (_label: string, windowMs: unknown) => {
            await expectInputError(memory.increment(VALID_KEY, windowMs as number, 10), 'windowMs');
            await expectInputError(memory.getCount(VALID_KEY, windowMs as number), 'windowMs');
            await expectInputError(
                sliding.increment(VALID_KEY, windowMs as number, 10),
                'windowMs'
            );
            await expectInputError(sliding.getCount(VALID_KEY, windowMs as number), 'windowMs');
        }
    );

    it('does not write in-memory state when a window is rejected', async () => {
        await expectInputError(memory.increment(VALID_KEY, 0, 10), 'windowMs');
        await expectInputError(memory.increment(VALID_KEY, MAX_WINDOW_MS + 1, 10), 'windowMs');
        await expectInputError(memory.getCount(VALID_KEY, Number.NaN), 'windowMs');

        // The rejected calls left no bucket behind.
        expect((await memory.getCount(VALID_KEY, VALID_WINDOW_MS)).count).toBe(0);
    });

    it('issues no Redis command when a window is rejected', async () => {
        const zcountSpy = vi.spyOn(client, 'zcount');
        const multiSpy = vi.spyOn(client, 'multi');

        await expectInputError(sliding.increment(VALID_KEY, 0, 10), 'windowMs');
        await expectInputError(sliding.increment(VALID_KEY, MAX_WINDOW_MS + 1, 10), 'windowMs');
        await expectInputError(sliding.getCount(VALID_KEY, Number.NaN), 'windowMs');

        expect(zcountSpy).not.toHaveBeenCalled();
        expect(multiSpy).not.toHaveBeenCalled();
        expect(client.getSortedSetKeys()).toHaveLength(0);
    });

    it('accepts the configured floor and ceiling windows (boundary)', async () => {
        const atFloor = await memory.increment(VALID_KEY, MIN_RATE_LIMIT_WINDOW_MS, 10);
        expect(atFloor.count).toBe(1);

        const atCeiling = await sliding.increment(VALID_KEY, MAX_WINDOW_MS, 10);
        expect(atCeiling.count).toBe(1);
        expect(client.getTtl(`fluxora:rl:${VALID_KEY.replace(/[^A-Za-z0-9._-]/g, '_')}`)).toBe(
            MAX_WINDOW_MS
        );
    });

    it('distinguishes a key rejection from a window rejection', async () => {
        const keyError = await memory.increment('', VALID_WINDOW_MS, 10).catch((e: unknown) => e);
        const windowError = await memory.increment(VALID_KEY, 0, 10).catch((e: unknown) => e);
        expect((keyError as RateLimitInputError).field).toBe('key');
        expect((windowError as RateLimitInputError).field).toBe('windowMs');
    });
});

// ---------------------------------------------------------------------------
// HybridStore — validation is not swallowed by the fallback path
// ---------------------------------------------------------------------------

describe('rateLimitStore — HybridStore input validation', () => {
    function unavailablePrimary(): RateLimitStore {
        return {
            async increment() {
                throw new Error('Redis down');
            },
            async getCount() {
                throw new Error('Redis down');
            },
            async close() {},
        };
    }

    function buildHybrid(): { hybrid: HybridStore; fallback: InMemoryStore; errors: string[] } {
        const fallback = new InMemoryStore();
        const errors: string[] = [];
        const hybrid = new HybridStore(unavailablePrimary(), fallback, (_err, op) =>
            errors.push(op)
        );
        return { hybrid, fallback, errors };
    }

    it('rejects invalid input instead of delegating it to the fallback', async () => {
        const { hybrid, errors } = buildHybrid();

        await expectInputError(hybrid.increment('', VALID_WINDOW_MS, 10), 'key');
        await expectInputError(hybrid.increment(VALID_KEY, 0, 10), 'windowMs');
        await expectInputError(hybrid.getCount(VALID_KEY, MAX_WINDOW_MS + 1), 'windowMs');

        // The primary was never exercised, so no error was reported and the store
        // was not switched into degraded mode.
        expect(errors).toEqual([]);
        expect(hybrid.usingFallback).toBe(false);
    });

    it('does not write fallback state when input is rejected', async () => {
        const { hybrid, fallback } = buildHybrid();

        await expectInputError(hybrid.increment(VALID_KEY, 0, 10), 'windowMs');

        expect((await fallback.getCount(VALID_KEY, VALID_WINDOW_MS)).count).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Valid input is unaffected
// ---------------------------------------------------------------------------

describe('rateLimitStore — valid input is unaffected', () => {
    it('a valid InMemoryStore call still increments and counts', async () => {
        const store = new InMemoryStore();
        expect((await store.increment(VALID_KEY, VALID_WINDOW_MS, 5)).count).toBe(1);
        expect((await store.increment(VALID_KEY, VALID_WINDOW_MS, 5)).count).toBe(2);
        expect((await store.getCount(VALID_KEY, VALID_WINDOW_MS)).count).toBe(2);
        expect((await store.getCount('other:key', VALID_WINDOW_MS)).count).toBe(0);
    });

    it('a valid SlidingWindowStore call still increments and counts', async () => {
        const client = new FakeRedisClient();
        const store = new SlidingWindowStore(client);
        expect((await store.increment(VALID_KEY, VALID_WINDOW_MS, 5)).count).toBe(1);
        expect((await store.increment(VALID_KEY, VALID_WINDOW_MS, 5)).count).toBe(2);
        expect((await store.getCount(VALID_KEY, VALID_WINDOW_MS)).count).toBe(2);
    });

    it('rejection is typed and self-describing for every store implementation', async () => {
        const client = new FakeRedisClient();
        const stores: RateLimitStore[] = [
            new InMemoryStore(),
            new SlidingWindowStore(client),
            new HybridStore(new InMemoryStore(), new InMemoryStore(), () => {}),
        ];
        for (const store of stores) {
            const error = await store.increment('', 0, 1).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(RateLimitInputError);
            expect((error as RateLimitInputError).message).toContain('key');
        }
    });
});
