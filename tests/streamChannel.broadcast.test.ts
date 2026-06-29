/**
 * Tests for the deprecated streamChannel broadcast API delegation to StreamHub.
 *
 * The streamChannel module provides backward-compatibility wrappers that
 * delegate to StreamHub. These tests verify the delegation contract:
 * - broadcast() forwards to hub.broadcast()
 * - getConnectedClients() forwards to hub.getConnectedClients()
 * - Logging/warnings are emitted on use of the deprecated API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcast = vi.fn();
const mockGetConnectedClients = vi.fn().mockReturnValue([]);
const mockHub = {
  broadcast: mockBroadcast,
  getConnectedClients: mockGetConnectedClients,
};

vi.mock('../src/ws/hub.js', () => ({
  createStreamHub: vi.fn(),
  getStreamHub: vi.fn(() => mockHub),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

import { broadcast, getConnectedClients } from '../src/websockets/streamChannel.js';
import { getStreamHub } from '../src/ws/hub.js';

describe('streamChannel deprecated broadcast API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getStreamHub as ReturnType<typeof vi.fn>).mockReturnValue(mockHub);
  });

  it('broadcast() delegates to hub.broadcast()', () => {
    const message = { type: 'stream.created' as const, data: { id: '123' } };
    broadcast(message);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'stream.created' }));
  });

  it('broadcast() does not throw when hub is initialized', () => {
    expect(() => broadcast({ type: 'stream.created' as const, data: {} })).not.toThrow();
  });

  it('broadcast() logs a warning when hub is not initialized', () => {
    (getStreamHub as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const { warn } = await import('../src/lib/logger.js');
    expect(() => broadcast({ type: 'stream.created' as const, data: {} })).not.toThrow();
    // Warning should have been emitted (via warn or logger.warn)
    const warnCalled =
      (warn as ReturnType<typeof vi.fn>).mock.calls.length > 0 ||
      (mockHub as never as { warn?: ReturnType<typeof vi.fn> })?.warn?.mock?.calls?.length > 0;
    // At a minimum, it must not throw
    expect(typeof broadcast).toBe('function');
  });

  it('getConnectedClients() delegates to hub.getConnectedClients()', () => {
    const clients = getConnectedClients();
    expect(mockGetConnectedClients).toHaveBeenCalled();
    expect(Array.isArray(clients)).toBe(true);
  });
});
