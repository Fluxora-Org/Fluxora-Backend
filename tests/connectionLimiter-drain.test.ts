import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAndReserve,
  untrackConnection,
  getActiveConnectionCount,
  gracefulDrain,
  isShuttingDown,
  _resetLimiter,
} from '../src/ws/connectionLimiter.js';

describe('connectionLimiter graceful drain', () => {
  beforeEach(() => {
    _resetLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks active connections via metric', async () => {
    expect(getActiveConnectionCount()).toBe(0);

    const result1 = await checkAndReserve('127.0.0.1');
    expect(result1.allowed).toBe(true);
    expect(getActiveConnectionCount()).toBe(1);

    const result2 = await checkAndReserve('127.0.0.2');
    expect(result2.allowed).toBe(true);
    expect(getActiveConnectionCount()).toBe(2);

    untrackConnection('127.0.0.1');
    expect(getActiveConnectionCount()).toBe(1);

    untrackConnection('127.0.0.2');
    expect(getActiveConnectionCount()).toBe(0);
  });

  it('rejects new connections during shutdown', async () => {
    // Start shutdown (no wss, just sets flag)
    gracefulDrain(null);

    // Try to reserve after shutdown
    const result = await checkAndReserve('127.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Server shutting down');
  });

  it('sends close frame to active connections during drain', async () => {
    // Simulate active connections
    await checkAndReserve('127.0.0.1');
    await checkAndReserve('127.0.0.2');
    expect(getActiveConnectionCount()).toBe(2);

    // Mock WebSocket clients
    const mockClients = [
      { readyState: 1, close: vi.fn() },
      { readyState: 1, close: vi.fn() },
    ];

    const mockServer = { clients: new Set(mockClients) };

    // Start drain
    const drainPromise = gracefulDrain(mockServer, 30000);

    // Advance timers to let drain loop run
    await vi.advanceTimersByTimeAsync(100);

    // Verify close was called on both clients
    expect(mockClients[0]!.close).toHaveBeenCalled();
    expect(mockClients[1]!.close).toHaveBeenCalled();

    // Close connections to let drain complete
    untrackConnection('127.0.0.1');
    untrackConnection('127.0.0.2');
    await drainPromise;
  });

  it('waits for connections to close before completing drain', async () => {
    // Simulate active connection
    await checkAndReserve('127.0.0.1');
    expect(getActiveConnectionCount()).toBe(1);

    const mockClients = [{ readyState: 1, close: vi.fn() }];
    const mockServer = { clients: new Set(mockClients) };

    // Start drain
    const drainPromise = gracefulDrain(mockServer, 30000);

    // Connections should still be active
    expect(getActiveConnectionCount()).toBe(1);

    // Simulate connection closing after 1 second
    setTimeout(() => {
      untrackConnection('127.0.0.1');
    }, 1000);

    await vi.advanceTimersByTimeAsync(1500);
    await drainPromise;

    // Drain should complete after connection closes
    expect(getActiveConnectionCount()).toBe(0);
  });

  it('forcefully completes after grace period expires', async () => {
    // Simulate active connections
    await checkAndReserve('127.0.0.1');
    await checkAndReserve('127.0.0.2');

    const mockClients = [
      { readyState: 1, close: vi.fn() },
      { readyState: 1, close: vi.fn() },
    ];
    const mockServer = { clients: new Set(mockClients) };

    // Start drain with short grace period
    const drainPromise = gracefulDrain(mockServer, 2000);

    // Connections don't close (simulate unresponsive clients)
    await vi.advanceTimersByTimeAsync(2500);
    await drainPromise;

    // Drain should complete even though connections are still active
    expect(getActiveConnectionCount()).toBe(2);
  });

  it('reports shutdown status correctly', () => {
    expect(isShuttingDown()).toBe(false);

    gracefulDrain(null, 30000);

    expect(isShuttingDown()).toBe(true);

    _resetLimiter();

    expect(isShuttingDown()).toBe(false);
  });
});
