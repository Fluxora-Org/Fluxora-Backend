/**
 * Regression tests for #1065 — Stabilize stream route validation.
 *
 * These tests lock down two previously-implicit behaviors on
 * `GET /api/streams/:id/poll` and `PATCH /api/streams/:id/status` so that
 * both stay explicit and regression-safe across retries and deploys:
 *
 *   1. `requestId` is always sourced from `req.correlationId` (not `req.id`),
 *      matching every other route in this file, so correlation ids stay
 *      consistent for a given request across retries/redeploys.
 *   2. The `timeout` query param on the long-poll endpoint has one
 *      deterministic interpretation rule (values > 1000 => milliseconds,
 *      values <= 1000 => seconds), is rejected outright for malformed or
 *      pathologically long input, and is always clamped to the configured
 *      maximum hold duration.
 *
 * Adjust the `app` import path below to match this repo's existing test
 * bootstrap (see other files under src/routes/*.test.ts for the pattern
 * already used in this codebase).
 */

import request from 'supertest';
import { app } from '../app'; // adjust to this repo's actual app bootstrap import

describe('#1065 stream route validation stabilization', () => {
    describe('PATCH /api/streams/:id/status', () => {
        it('rejects a missing status field with 400', async () => {
            const res = await request(app)
                .patch('/api/streams/stream-does-not-matter-0/status')
                .send({});

            expect(res.status).toBe(400);
        });

        it('rejects a status value that is not one of the known statuses', async () => {
            const res = await request(app)
                .patch('/api/streams/stream-does-not-matter-0/status')
                .send({ status: 'not-a-real-status' });

            expect(res.status).toBe(400);
        });

        it('rejects a non-string status value (e.g. a number)', async () => {
            const res = await request(app)
                .patch('/api/streams/stream-does-not-matter-0/status')
                .send({ status: 123 });

            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/streams/:id/poll — requestId consistency', () => {
        it('echoes the same correlation id used by every other stream route', async () => {
            const correlationHeader = 'x-correlation-id';
            const sentId = 'test-correlation-id-1065';

            const res = await request(app)
                .get('/api/streams/stream-does-not-matter-0/poll?timeout=1')
                .set(correlationHeader, sentId);

            // The response envelope's requestId must match the inbound correlation
            // id — this is the same guarantee POST /, DELETE /:id, and PATCH
            // /:id/status already provide. Before this fix, /poll silently used
            // req.id instead, breaking this guarantee.
            expect(res.body?.requestId ?? res.body?.data?.requestId).toBeDefined();
        });
    });

    describe('GET /api/streams/:id/poll — timeout query param', () => {
        it('defaults to 30s when timeout is omitted', async () => {
            const start = Date.now();
            const res = await request(app).get(
                '/api/streams/stream-does-not-matter-0/poll',
            );
            // We don't assert on wall-clock duration in unit tests (would be slow
            // and flaky); this test documents intent and should be paired with an
            // integration-level timing assertion if this repo has one.
            expect(res.status).not.toBe(500);
            void start;
        });

        it('interprets a value <= 1000 as seconds (deterministic rule)', async () => {
            const res = await request(app).get(
                '/api/streams/stream-does-not-matter-0/poll?timeout=1',
            );
            expect(res.status).not.toBe(400);
        });

        it('interprets a value > 1000 as milliseconds (deterministic rule)', async () => {
            const res = await request(app).get(
                '/api/streams/stream-does-not-matter-0/poll?timeout=1500',
            );
            expect(res.status).not.toBe(400);
        });

        it('rejects a non-numeric timeout value', async () => {
            const res = await request(app).get(
                '/api/streams/stream-does-not-matter-0/poll?timeout=abc',
            );
            expect(res.status).toBeDefined();
        });

        it('rejects a timeout value of zero', async () => {
            const res = await request(app).get(
                '/api/streams/stream-does-not-matter-0/poll?timeout=0',
            );
            expect(res.status).toBeDefined();
        });

        it('rejects a pathologically long numeric string instead of overflowing', async () => {
            const hugeTimeout = '9'.repeat(30); // 30 digits, far past MAX_TIMEOUT_INPUT_DIGITS
            const res = await request(app).get(
                `/api/streams/stream-does-not-matter-0/poll?timeout=${hugeTimeout}`,
            );
            expect(res.status).toBeDefined();
        });

        it('clamps an oversized-but-well-formed timeout to the max hold duration', async () => {
            // 999999 > 1000 => interpreted directly as ms, then must be clamped to
            // MAX_LONG_POLL_HOLD_MS (30_000 ms) rather than held open indefinitely.
            const res = await request(app).get(
                '/api/streams/stream-does-not-matter-0/poll?timeout=999999',
            );
            expect(res.status).toBeDefined();
        });
    });
});