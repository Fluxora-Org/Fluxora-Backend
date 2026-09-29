/**
 * WebSocket liveness and stall probes.
 *
 * An OPEN socket is not automatically healthy: when frames buffer faster than
 * the peer drains them, the connection is effectively stalled even though the
 * TCP session is fine. A probe pass therefore reports three states —
 * healthy, stalled, unhealthy — and terminates connections that have missed
 * `maxMissed` consecutive pongs.
 *
 * @module ws/healthProbe
 */

import { WebSocket } from 'ws';
import { updateWsHealthMetrics } from '../metrics/wsHealth.js';
import type { ConnectionRegistry } from './connectionRegistry.js';

/** Settings and state a probe pass needs. */
export interface HealthProbeDeps {
  registry: ConnectionRegistry;
  /** Consecutive missed pongs tolerated before a connection is terminated. */
  maxMissed: number;
  /**
   * Outbound `bufferedAmount` (in bytes) above which an OPEN connection is
   * classified as stalled rather than healthy.
   */
  stallBytes: number;
}

/**
 * Run a single probe pass: ping every open connection, count the outcomes, and
 * publish them to the WebSocket health metrics.
 */
export function runHealthProbes(deps: HealthProbeDeps): void {
  const { registry, maxMissed, stallBytes } = deps;
  let healthyCount = 0;
  let stalledCount = 0;
  let unhealthyCount = 0;

  for (const [ws, state] of registry.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    if (state.missedPongs >= maxMissed) {
      unhealthyCount++;
      ws.terminate();
      continue;
    }

    // Report a saturated outbound queue as stalled rather than healthy so the
    // health signal reflects the actual failure state. The liveness probe is
    // still applied so a stalled client that also stops ponging escalates to
    // unhealthy on a later pass.
    if (ws.bufferedAmount > stallBytes) {
      stalledCount++;
    } else {
      healthyCount++;
    }

    state.missedPongs++;
    ws.ping();
  }

  updateWsHealthMetrics(healthyCount, unhealthyCount, stalledCount);
}
