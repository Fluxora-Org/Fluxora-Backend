import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { StreamHub } from '../../src/ws/hub.js';
import { _resetLimiter } from '../../src/ws/connectionLimiter.js';

/**
 * Concurrency test suite for WebSocket upgrade TOCTOU race condition fix.
 * 
 * SECURITY NOTES:
 * - Tests that N simultaneous upgrade requests from one IP only result in
 *   the allowed number of connections being established (cap is enforced).
 * - Validates that counter is not incremented twice for any connection.
 * - Tests upgrade failure paths to ensure counter is released exactly once.
 */

function setup(): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
  const server = http.createServer();
  const hub = new StreamHub(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, hub, port: address.port });
    });
  });
}

function teardown(server: http.Server, hub: StreamHub): Promise<void> {
  return new Promise((resolve) => {
    hub.close(() => server.close(() => resolve()));
  });
}

/**
 * Attempts to connect to the WebSocket server.
 * Returns { success: true, ws } on success, or { success: false, error } on failure.
 */
function attemptConnect(port: number): Promise<{ success: boolean; ws?: WebSocket; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`, {
      handshakeTimeout: 5000,
    });

    const handleOpen = () => {
      ws.removeAllListeners();
      resolve({ success: true, ws });
    };

    const handleError = (event: Error) => {
      ws.removeAllListeners();
      ws.close();
      resolve({ success: false, error: event.message });
    };

    const handleClose = () => {
      ws.removeAllListeners();
      resolve({ success: false, error: 'Connection closed during handshake' });
    };

    ws.once('open', handleOpen);
    ws.once('error', handleError);
    ws.once('close', handleClose);
  });
}

/**
 * Gracefully close a WebSocket.
 */
function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
    setTimeout(() => resolve(), 100); // fallback
  });
}

describe('WebSocket upgrade TOCTOU concurrency', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
    _resetLimiter();
    // Set max connections to 3 for testing
    process.env.WS_MAX_CONNECTIONS_PER_IP = '3';
  });

  afterEach(async () => {
    _resetLimiter();
    delete process.env.WS_MAX_CONNECTIONS_PER_IP;
    await teardown(server, hub);
  });

  it('enforces per-IP cap under concurrent upgrade requests', async () => {
    /**
     * ATTACK SCENARIO: Attacker sends N simultaneous upgrade requests from one IP.
     * EXPECTED: Only max (3) connections succeed; the rest are rejected.
     * SECURITY PROPERTY: Even under concurrent conditions, the cap cannot be bypassed.
     */
    const maxConnections = 3;
    const attemptCount = 10; // Try to open more than the limit simultaneously
    const ip = '127.0.0.1';

    // Fire N simultaneous connection attempts
    const attempts = Array(attemptCount)
      .fill(null)
      .map(() => attemptConnect(port));

    const results = await Promise.all(attempts);
    const successfulConnections = results.filter((r) => r.success);

    // Verify: exactly maxConnections succeeded
    expect(successfulConnections).toHaveLength(maxConnections);

    // Verify: remaining attempts were rejected
    const failedAttempts = results.filter((r) => !r.success);
    expect(failedAttempts).toHaveLength(attemptCount - maxConnections);

    // Cleanup
    await Promise.all(
      successfulConnections.map((r) => (r.ws ? closeWs(r.ws) : Promise.resolve()))
    );
  });

  it('handles upgrade failure without counter leaks', async () => {
    /**
     * SCENARIO: Open max connections, verify that new attempts are rejected.
     * Then close one connection and verify new attempt succeeds.
     * This tests that counter is properly decremented on close.
     */
    const maxConnections = 3;
    process.env.WS_MAX_CONNECTIONS_PER_IP = String(maxConnections);

    // Fill the connection limit
    const connections: WebSocket[] = [];
    for (let i = 0; i < maxConnections; i++) {
      const result = await attemptConnect(port);
      expect(result.success).toBe(true);
      expect(result.ws).toBeDefined();
      connections.push(result.ws!);
    }

    // Verify: new attempts are rejected
    const rejectedResult1 = await attemptConnect(port);
    expect(rejectedResult1.success).toBe(false);

    // Close one connection
    await closeWs(connections[0]);

    // Wait a tick for cleanup
    await new Promise((resolve) => setImmediate(resolve));

    // Verify: new attempt succeeds (slot was released)
    const newResult = await attemptConnect(port);
    expect(newResult.success).toBe(true);
    expect(newResult.ws).toBeDefined();

    // Cleanup
    connections.splice(0, 1); // remove closed connection
    connections.push(newResult.ws!);
    await Promise.all(connections.map((ws) => closeWs(ws)));
  });

  it('handles multiple concurrent close events without underflow', async () => {
    /**
     * SCENARIO: Open connections and immediately close multiple in parallel.
     * SECURITY: Verify counter doesn't go negative (underflow) if close/error
     * events fire concurrently.
     */
    const connectCount = 5;
    // Temporarily allow 5+ connections for this test
    process.env.WS_MAX_CONNECTIONS_PER_IP = String(connectCount + 1);

    // Open multiple connections
    const connections: WebSocket[] = [];
    for (let i = 0; i < connectCount; i++) {
      const result = await attemptConnect(port);
      expect(result.success).toBe(true);
      connections.push(result.ws!);
    }

    // Close all in parallel
    await Promise.all(connections.map((ws) => closeWs(ws)));

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify: new connections work (counter should be at 0)
    for (let i = 0; i < 3; i++) {
      const result = await attemptConnect(port);
      expect(result.success).toBe(true);
      expect(result.ws).toBeDefined();
      await closeWs(result.ws!);
    }
  });

  it('stress test: rapid sequential connections after limit', async () => {
    /**
     * SCENARIO: Rapidly cycle through connections at the limit.
     * Tests that under high frequency, the counter remains accurate.
     */
    const maxConnections = 2;
    process.env.WS_MAX_CONNECTIONS_PER_IP = String(maxConnections);

    for (let cycle = 0; cycle < 5; cycle++) {
      // Fill the limit
      const connections: WebSocket[] = [];
      for (let i = 0; i < maxConnections; i++) {
        const result = await attemptConnect(port);
        expect(result.success).toBe(true);
        connections.push(result.ws!);
      }

      // Verify new attempts fail
      const rejected = await attemptConnect(port);
      expect(rejected.success).toBe(false);

      // Close all
      await Promise.all(connections.map((ws) => closeWs(ws)));

      // Wait for cleanup
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('correctly rejects after N rejections trigger ban', async () => {
    /**
     * SCENARIO: Fill the connection limit, then trigger rejections that lead to a ban.
     * After the ban is triggered, new connections should be rejected immediately.
     */
    const maxConnections = 2;
    process.env.WS_MAX_CONNECTIONS_PER_IP = String(maxConnections);
    process.env.WS_ABUSE_THRESHOLD = '2'; // Ban after 2 rejections

    // Fill the limit
    const connections: WebSocket[] = [];
    for (let i = 0; i < maxConnections; i++) {
      const result = await attemptConnect(port);
      expect(result.success).toBe(true);
      connections.push(result.ws!);
    }

    // Trigger rejections (more than abuse threshold)
    const rejection1 = await attemptConnect(port);
    const rejection2 = await attemptConnect(port);
    const rejection3 = await attemptConnect(port); // Should trigger ban

    expect(rejection1.success).toBe(false);
    expect(rejection2.success).toBe(false);
    expect(rejection3.success).toBe(false);

    // Close existing connections to unblock the IP (but it should still be banned)
    await Promise.all(connections.map((ws) => closeWs(ws)));
    await new Promise((resolve) => setImmediate(resolve));

    // Verify: IP is banned even after closing all connections
    const stillBanned = await attemptConnect(port);
    expect(stillBanned.success).toBe(false);

    // Reset ban state for cleanup
    _resetLimiter();
  });

  it('simultaneously upgrades, closes, and attempts rejections', async () => {
    /**
     * SCENARIO: Complex concurrent scenario with mixed operations.
     * Opens connections, closes some, attempts new ones, all in parallel.
     * This is a realistic attack/usage pattern that could expose race conditions.
     */
    const maxConnections = 2;
    process.env.WS_MAX_CONNECTIONS_PER_IP = String(maxConnections);

    // Open 2 connections
    const conn1 = await attemptConnect(port);
    const conn2 = await attemptConnect(port);
    expect(conn1.success).toBe(true);
    expect(conn2.success).toBe(true);

    // Start closing one while attempting new ones
    const closePromise = closeWs(conn1.ws!).then(() =>
      attemptConnect(port).then((r) => (r.success ? closeWs(r.ws!) : Promise.resolve()))
    );

    // Meanwhile, try multiple simultaneous upgrades
    const simultaneousAttempts = Array(5)
      .fill(null)
      .map(() => attemptConnect(port));

    const attemptResults = await Promise.all(simultaneousAttempts);
    await closePromise;

    // Verify: at most 1 succeeded (since 2 are already open and 1 is closing)
    const succeeded = attemptResults.filter((r) => r.success);
    expect(succeeded.length).toBeLessThanOrEqual(1);

    // Cleanup
    await closeWs(conn2.ws!);
    await Promise.all(succeeded.map((r) => (r.ws ? closeWs(r.ws) : Promise.resolve())));
  });
});
