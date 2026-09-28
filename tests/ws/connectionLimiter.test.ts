import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLimiter,
  checkAndReserve,
  untrackConnection,
} from '../../src/ws/connectionLimiter.js';

describe('WebSocket reconnect abuse protection', () => {
  beforeEach(() => {
    process.env.WS_MAX_CONNECTIONS_PER_IP = '1';
    process.env.WS_RECONNECT_LIMIT = '2';
    process.env.WS_RECONNECT_WINDOW_MS = '60000';
    _resetLimiter();
  });

  afterEach(() => {
    _resetLimiter();
  });

  it('bounds rapid reconnects even when each prior socket closes', async () => {
    const ip = '203.0.113.10';

    expect((await checkAndReserve(ip)).allowed).toBe(true);
    untrackConnection(ip);
    expect((await checkAndReserve(ip)).allowed).toBe(true);
    untrackConnection(ip);

    const result = await checkAndReserve(ip);
    expect(result).toMatchObject({
      allowed: false,
      code: 4029,
      reason: 'Reconnect rate exceeded',
    });
  });
});