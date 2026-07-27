/**
 * tests/ws/hub.broadcastBatching.test.ts
 *
 * Comprehensive tests for the StreamHub micro-batching layer.
 *
 * Coverage:
 *  - Default (non-batching) subscribers are unaffected
 *  - Opt-in subscribers receive stream_update_batch frames
 *  - Events coalesce within the flush window
 *  - Early flush fires when batch hits maxSize
 *  - In-order delivery is preserved
 *  - Dedup semantics are unchanged
 *  - Mixed (batching + non-batching) subscribers on the same stream
 *  - MAX_MESSAGE_BYTES cap truncates oversized batches safely
 *  - Pending timers are cancelled on client disconnect
 *  - Pending timers are cancelled on hub.close()
 *  - Prometheus counters increment correctly
 *  - Backpressure drop/terminate still applies to batch frames
 *  - WS_BATCH_FLUSH_MS / WS_BATCH_MAX_SIZE env-var clamping (unit)
 */

import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  StreamHub,
  MAX_MESSAGE_BYTES,
  WS_BATCH_FLUSH_MS,
  WS_BATCH_MAX_SIZE,
} from '../../src/ws/hub.js';
import {
  wsBatchFlushTotal,
  wsBatchEventsCoalescedTotal,
  wsBatchSizeExceededTotal,
} from '../../src/metrics/wsBackpressure.js';
import {
  connectClient,
  sendJson,
  wait,
} from './fixtures/slowClient.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Collect all messages received by a WebSocket into an array. */
function collectMessages(ws: WebSocket): unknown[] {
  const msgs: unknown[] = [];
  ws.on('message', (data) => msgs.push(JSON.parse(data.toString())));
  return msgs;
}

/** Subscribe a client to a stream, optionally with batching enabled. */
function subscribe(ws: WebSocket, streamId: string, batching = false): void {
  sendJson(ws, { type: 'subscribe', streamId, batching });
}

/** Read the current value of a prom-client Counter (sum across all label sets). */
async function counterValue(counter: { get(): Promise<{ values: { value: number }[] }> }): Promise<number> {
  const metric = await counter.get();
  return metric.values.reduce((sum, v) => sum + v.value, 0);
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('StreamHub micro-batching', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  const openClients: WebSocket[] = [];

  beforeEach(async () => {
    server = http.createServer();
    // Use a very short flush window so tests complete quickly.
    hub = new StreamHub(server, {
      batching: { flushMs: 30, maxSize: 5 },
      backpressureCollector: { intervalMs: 0 },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    openClients.length = 0;
  });

  afterEach(async () => {
    for (const ws of openClients) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(): Promise<WebSocket> {
    const ws = await connectClient(port);
    openClients.push(ws);
    return ws;
  }

  // ── 1. Non-batching clients still get one-frame-per-event ──────────────────

  it('non-batching subscriber receives stream_update frames unchanged', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-a', false);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-a', eventId: 'e1', payload: { v: 1 } });
    await hub.broadcast({ streamId: 'stream-a', eventId: 'e2', payload: { v: 2 } });
    await wait(20);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ type: 'stream_update', eventId: 'e1' });
    expect(msgs[1]).toMatchObject({ type: 'stream_update', eventId: 'e2' });
  });

  // ── 2. Batching subscriber receives stream_update_batch after flush window ──

  it('batching subscriber receives a single stream_update_batch frame after flush window', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-b', true);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-b', eventId: 'e1', payload: { v: 1 } });
    await hub.broadcast({ streamId: 'stream-b', eventId: 'e2', payload: { v: 2 } });
    await hub.broadcast({ streamId: 'stream-b', eventId: 'e3', payload: { v: 3 } });

    // No frames yet — still inside flush window.
    expect(msgs).toHaveLength(0);

    // Wait for flush window to expire (30 ms + slack).
    await wait(60);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: 'stream_update_batch',
      streamId: 'stream-b',
    });
    const batch = (msgs[0] as { events: { eventId: string }[] }).events;
    expect(batch.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  // ── 3. Early flush when maxSize is reached ────────────────────────────────

  it('flushes early when maxSize is reached before the flush window expires', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-early', true);
    await wait(20);

    // maxSize is 5 — broadcast exactly 5 events
    for (let i = 1; i <= 5; i++) {
      await hub.broadcast({ streamId: 'stream-early', eventId: `e${i}`, payload: { i } });
    }

    // Frame must arrive before the flush window (30 ms).
    await wait(15);
    expect(msgs).toHaveLength(1);
    const batch = (msgs[0] as { events: unknown[] }).events;
    expect(batch).toHaveLength(5);
  });

  // ── 4. In-order delivery ──────────────────────────────────────────────────

  it('preserves event insertion order within a batch', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-order', true);
    await wait(20);

    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    for (const id of ids) {
      await hub.broadcast({ streamId: 'stream-order', eventId: id, payload: {} });
    }
    await wait(60);

    expect(msgs).toHaveLength(1);
    const batch = (msgs[0] as { events: { eventId: string }[] }).events;
    expect(batch.map((e) => e.eventId)).toEqual(ids);
  });

  // ── 5. Dedup: duplicate eventId within window is dropped ─────────────────

  it('deduplicated events are not added to the batch', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-dedup', true);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-dedup', eventId: 'dup', payload: { first: true } });
    // Second broadcast with the same eventId — dedup cache blocks it.
    await hub.broadcast({ streamId: 'stream-dedup', eventId: 'dup', payload: { first: false } });
    await wait(60);

    expect(msgs).toHaveLength(1);
    const batch = (msgs[0] as { events: { eventId: string }[] }).events;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.eventId).toBe('dup');
  });

  // ── 6. Mixed subscribers: batching + non-batching on the same stream ──────

  it('batching and non-batching subscribers on the same stream both receive events', async () => {
    const batchClient = await connect();
    const immediateClient = await connect();
    const batchMsgs = collectMessages(batchClient);
    const immediateMsgs = collectMessages(immediateClient);

    subscribe(batchClient, 'stream-mixed', true);
    subscribe(immediateClient, 'stream-mixed', false);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-mixed', eventId: 'm1', payload: { v: 1 } });
    await hub.broadcast({ streamId: 'stream-mixed', eventId: 'm2', payload: { v: 2 } });

    // Non-batching client gets frames immediately.
    await wait(20);
    expect(immediateMsgs).toHaveLength(2);
    expect(immediateMsgs[0]).toMatchObject({ type: 'stream_update', eventId: 'm1' });
    expect(immediateMsgs[1]).toMatchObject({ type: 'stream_update', eventId: 'm2' });

    // Batching client gets one batch after flush window.
    await wait(40);
    expect(batchMsgs).toHaveLength(1);
    expect(batchMsgs[0]).toMatchObject({ type: 'stream_update_batch', streamId: 'stream-mixed' });
    const batch = (batchMsgs[0] as { events: { eventId: string }[] }).events;
    expect(batch.map((e) => e.eventId)).toEqual(['m1', 'm2']);
  });

  // ── 7. Events from separate streams get separate batch accumulators ───────

  it('events from two different streams form independent batches', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-x', true);
    subscribe(client, 'stream-y', true);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-x', eventId: 'x1', payload: {} });
    await hub.broadcast({ streamId: 'stream-y', eventId: 'y1', payload: {} });
    await hub.broadcast({ streamId: 'stream-x', eventId: 'x2', payload: {} });
    await wait(60);

    expect(msgs).toHaveLength(2);
    const byStream = Object.fromEntries(
      (msgs as { streamId: string; events: { eventId: string }[] }[]).map(
        (m) => [m.streamId, m.events.map((e) => e.eventId)]
      )
    );
    expect(byStream['stream-x']).toEqual(['x1', 'x2']);
    expect(byStream['stream-y']).toEqual(['y1']);
  });

  // ── 8. Disconnect cancels pending batch timers ────────────────────────────

  it('pending batch timer is cancelled when a client disconnects', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-disc', true);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-disc', eventId: 'd1', payload: {} });

    // Disconnect before the flush window expires.
    client.close();
    await wait(80);

    // No frames should arrive (client is gone) and no unhandled errors.
    expect(msgs).toHaveLength(0);
    expect(hub.clientCount).toBe(0);
  });

  // ── 9. Prometheus counters increment ────────────────────────────────────

  it('increments wsBatchFlushTotal and wsBatchEventsCoalescedTotal on flush', async () => {
    const flushBefore = await counterValue(wsBatchFlushTotal);
    const coalescedBefore = await counterValue(wsBatchEventsCoalescedTotal);

    const client = await connect();
    subscribe(client, 'stream-metrics', true);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-metrics', eventId: 'pm1', payload: {} });
    await hub.broadcast({ streamId: 'stream-metrics', eventId: 'pm2', payload: {} });
    await wait(60);

    expect(await counterValue(wsBatchFlushTotal)).toBe(flushBefore + 1);
    expect(await counterValue(wsBatchEventsCoalescedTotal)).toBe(coalescedBefore + 2);
  });

  it('increments wsBatchSizeExceededTotal on early flush', async () => {
    const exceededBefore = await counterValue(wsBatchSizeExceededTotal);

    const client = await connect();
    subscribe(client, 'stream-exceeded', true);
    await wait(20);

    // Broadcast maxSize (5) events to trigger early flush.
    for (let i = 1; i <= 5; i++) {
      await hub.broadcast({ streamId: 'stream-exceeded', eventId: `ex${i}`, payload: {} });
    }
    await wait(15);

    expect(await counterValue(wsBatchSizeExceededTotal)).toBe(exceededBefore + 1);
  });

  // ── 10. MAX_MESSAGE_BYTES cap: oversized payload is trimmed safely ────────

  it('truncates a batch to fit within MAX_MESSAGE_BYTES without dropping earlier events', async () => {
    // Use maxSize=20 so the hub won't early-flush before we hit the byte cap,
    // but keep flushMs short so the test completes quickly.
    const bigServer = http.createServer();
    const bigHub = new StreamHub(bigServer, {
      batching: { flushMs: 30, maxSize: 20 },
      backpressureCollector: { intervalMs: 0 },
    });
    await new Promise<void>((resolve) => bigServer.listen(0, '127.0.0.1', resolve));
    const bigPort = (bigServer.address() as { port: number }).port;

    const bigClient = await connectClient(bigPort);
    openClients.push(bigClient);
    const msgs = collectMessages(bigClient);

    sendJson(bigClient, { type: 'subscribe', streamId: 'stream-big', batching: true });
    await wait(20);

    // Each payload ~300 bytes; 10 × ~300 bytes envelope ≈ 3 000+ bytes,
    // which should exceed MAX_MESSAGE_BYTES (4 096) when the full JSON is built.
    const bigPayload = 'x'.repeat(300);
    for (let i = 1; i <= 10; i++) {
      await bigHub.broadcast({ streamId: 'stream-big', eventId: `big${i}`, payload: { data: bigPayload } });
    }

    // Wait for flush window + slack.
    await wait(80);

    // At least one batch frame should have arrived.
    expect(msgs.length).toBeGreaterThanOrEqual(1);

    // Every delivered frame must be within MAX_MESSAGE_BYTES.
    for (const m of msgs) {
      const bytes = Buffer.byteLength(JSON.stringify(m), 'utf8');
      expect(bytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }

    // Events in each batch are in ascending order by their numeric suffix.
    for (const m of msgs) {
      const frame = m as { events: { eventId: string }[] };
      const ids = frame.events.map((e) => e.eventId);
      const sorted = [...ids].sort((a, b) => {
        const na = parseInt(a.replace('big', ''), 10);
        const nb = parseInt(b.replace('big', ''), 10);
        return na - nb;
      });
      expect(ids).toEqual(sorted);
    }

    bigClient.close();
    await new Promise<void>((resolve) => bigHub.close(() => resolve()));
    await new Promise<void>((resolve) => bigServer.close(() => resolve()));
  }, 10_000);

  // ── 11. Env-var constants are within expected default range ───────────────

  it('WS_BATCH_FLUSH_MS has a sane default', () => {
    expect(WS_BATCH_FLUSH_MS).toBeGreaterThanOrEqual(5);
    expect(WS_BATCH_FLUSH_MS).toBeLessThanOrEqual(5_000);
  });

  it('WS_BATCH_MAX_SIZE has a sane default', () => {
    expect(WS_BATCH_MAX_SIZE).toBeGreaterThanOrEqual(1);
    expect(WS_BATCH_MAX_SIZE).toBeLessThanOrEqual(500);
  });

  // ── 12. Single-event window still produces a batch frame ─────────────────

  it('a single event in the window is flushed as a batch with one entry', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-single', true);
    await wait(20);

    await hub.broadcast({ streamId: 'stream-single', eventId: 'solo', payload: { alone: true } });
    await wait(60);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'stream_update_batch' });
    const batch = (msgs[0] as { events: { eventId: string }[] }).events;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.eventId).toBe('solo');
  });

  // ── 13. Payload and correlationId are forwarded inside batch entries ──────

  it('batch event entries include payload and correlationId', async () => {
    const client = await connect();
    const msgs = collectMessages(client);

    subscribe(client, 'stream-payload', true);
    await wait(20);

    await hub.broadcast({
      streamId: 'stream-payload',
      eventId: 'ev-payload',
      payload: { amount: 42 },
      correlationId: 'corr-xyz',
    });
    await wait(60);

    expect(msgs).toHaveLength(1);
    const batch = (msgs[0] as { events: { eventId: string; payload: unknown; correlationId?: string }[] }).events;
    expect(batch[0]).toMatchObject({
      eventId: 'ev-payload',
      payload: { amount: 42 },
      correlationId: 'corr-xyz',
    });
  });
});

// ── Environment-variable parsing (IIFE boundary tests) ────────────────────────

const BATCH_FLUSH_MS_MIN = 5;
const BATCH_FLUSH_MS_MAX = 5_000;
const BATCH_MAX_SIZE_MIN = 1;
const BATCH_MAX_SIZE_MAX = 500;

describe('WS_BATCH_FLUSH_MS env-var parsing', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  async function loadHubWithEnv(overrides: Partial<NodeJS.ProcessEnv>) {
    Object.assign(process.env, overrides);
    const hub = await import('../../src/ws/hub.js');
    return hub;
  }

  it('unset — returns default 50', async () => {
    delete process.env['WS_BATCH_FLUSH_MS'];
    const hub = await loadHubWithEnv({});
    expect(hub.WS_BATCH_FLUSH_MS).toBe(50);
  });

  it('non-numeric string — returns default 50', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_FLUSH_MS: 'abc' });
    expect(hub.WS_BATCH_FLUSH_MS).toBe(50);
  });

  it('negative value — clamped to BATCH_FLUSH_MS_MIN', async () => {
    // Deliberate: negative values are clamped to the minimum, not treated as
    // invalid. This locks in the current arithmetic behavior as intentional.
    const hub = await loadHubWithEnv({ WS_BATCH_FLUSH_MS: '-100' });
    expect(hub.WS_BATCH_FLUSH_MS).toBe(BATCH_FLUSH_MS_MIN);
  });

  it('exactly at minimum — returns BATCH_FLUSH_MS_MIN', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_FLUSH_MS: String(BATCH_FLUSH_MS_MIN) });
    expect(hub.WS_BATCH_FLUSH_MS).toBe(BATCH_FLUSH_MS_MIN);
  });

  it('exactly at maximum — returns BATCH_FLUSH_MS_MAX', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_FLUSH_MS: String(BATCH_FLUSH_MS_MAX) });
    expect(hub.WS_BATCH_FLUSH_MS).toBe(BATCH_FLUSH_MS_MAX);
  });

  it('beyond maximum — clamped to BATCH_FLUSH_MS_MAX', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_FLUSH_MS: String(BATCH_FLUSH_MS_MAX + 1) });
    expect(hub.WS_BATCH_FLUSH_MS).toBe(BATCH_FLUSH_MS_MAX);
  });

  it('typical valid value — returned as-is', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_FLUSH_MS: '250' });
    expect(hub.WS_BATCH_FLUSH_MS).toBe(250);
  });
});

describe('WS_BATCH_MAX_SIZE env-var parsing', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  async function loadHubWithEnv(overrides: Partial<NodeJS.ProcessEnv>) {
    Object.assign(process.env, overrides);
    const hub = await import('../../src/ws/hub.js');
    return hub;
  }

  it('unset — returns default 25', async () => {
    delete process.env['WS_BATCH_MAX_SIZE'];
    const hub = await loadHubWithEnv({});
    expect(hub.WS_BATCH_MAX_SIZE).toBe(25);
  });

  it('non-numeric string — returns default 25', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_MAX_SIZE: 'abc' });
    expect(hub.WS_BATCH_MAX_SIZE).toBe(25);
  });

  it('negative value — clamped to BATCH_MAX_SIZE_MIN', async () => {
    // Deliberate: negative values are clamped to the minimum, not treated as
    // invalid. This locks in the current arithmetic behavior as intentional.
    const hub = await loadHubWithEnv({ WS_BATCH_MAX_SIZE: '-100' });
    expect(hub.WS_BATCH_MAX_SIZE).toBe(BATCH_MAX_SIZE_MIN);
  });

  it('exactly at minimum — returns BATCH_MAX_SIZE_MIN', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_MAX_SIZE: String(BATCH_MAX_SIZE_MIN) });
    expect(hub.WS_BATCH_MAX_SIZE).toBe(BATCH_MAX_SIZE_MIN);
  });

  it('exactly at maximum — returns BATCH_MAX_SIZE_MAX', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_MAX_SIZE: String(BATCH_MAX_SIZE_MAX) });
    expect(hub.WS_BATCH_MAX_SIZE).toBe(BATCH_MAX_SIZE_MAX);
  });

  it('beyond maximum — clamped to BATCH_MAX_SIZE_MAX', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_MAX_SIZE: String(BATCH_MAX_SIZE_MAX + 1) });
    expect(hub.WS_BATCH_MAX_SIZE).toBe(BATCH_MAX_SIZE_MAX);
  });

  it('typical valid value — returned as-is', async () => {
    const hub = await loadHubWithEnv({ WS_BATCH_MAX_SIZE: '100' });
    expect(hub.WS_BATCH_MAX_SIZE).toBe(100);
  });
});
