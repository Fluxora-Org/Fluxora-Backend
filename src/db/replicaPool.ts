/**
 * Replica pool with replication-lag health checking and automatic failover.
 *
 * Reads are routed to the replica when it is healthy (lag ≤ threshold).
 * When lag exceeds `REPLICA_LAG_THRESHOLD_MS`, reads fall back to the primary
 * and the replica is re-evaluated on the next health check.
 *
 * The failover is fully reversible: once the replica catches up the router
 * returns reads to it without any manual intervention.
 *
 * @module replicaPool
 */

import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { replicaLagMs, replicaFailoversTotal } from '../metrics/businessMetrics.js';

export interface ReplicaPoolOptions {
  /** Read-replica pg.Pool instance (may be null when no replica is configured). */
  replicaPool: pg.Pool | null;
  /** Primary pg.Pool instance used for writes and as a read fallback. */
  primaryPool: pg.Pool;
  /** Lag threshold in milliseconds; reads fall over to primary above this value. */
  lagThresholdMs: number;
}

export interface ReplicaHealthResult {
  /** Whether the replica is healthy and lag is below threshold. */
  healthy: boolean;
  /** Replication lag in milliseconds, or -1 when the probe could not complete. */
  lagMs: number;
  /** Human-readable reason when healthy is false. */
  reason?: string;
}

/**
 * Probe the replica's replication lag and return a health verdict.
 *
 * Runs two lightweight queries:
 *   1. `pg_last_xact_replay_timestamp()` — time of the last replayed WAL record.
 *   2. `NOW()` — current time on the replica (avoids clock-skew from the app server).
 *
 * The difference is the replication lag.  If either query throws, or the
 * replica has never replayed any WAL (cold standby), the probe returns
 * `healthy: false` without throwing so callers can fall back gracefully.
 *
 * @param replica - A connected pg.PoolClient obtained from the replica pool.
 * @param lagThresholdMs - Maximum acceptable lag in milliseconds.
 */
export async function checkReplicaHealth(
  replica: pg.PoolClient,
  lagThresholdMs: number,
): Promise<ReplicaHealthResult> {
  try {
    const result = await replica.query<{ lag_ms: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms`,
    );

    const raw = result.rows[0]?.lag_ms;

    // NULL means the replica has never replayed any WAL — treat as unavailable.
    if (raw === null || raw === undefined) {
      replicaLagMs.set(-1);
      return { healthy: false, lagMs: -1, reason: 'replica has not yet replayed any WAL' };
    }

    const lag = Math.round(Number(raw));
    replicaLagMs.set(lag);

    if (lag > lagThresholdMs) {
      return {
        healthy: false,
        lagMs: lag,
        reason: `replication lag ${lag}ms exceeds threshold ${lagThresholdMs}ms`,
      };
    }

    return { healthy: true, lagMs: lag };
  } catch (err) {
    replicaLagMs.set(-1);
    return {
      healthy: false,
      lagMs: -1,
      reason: `lag probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * A pool router that transparently falls over stale replica reads to the primary.
 *
 * ### Usage
 * ```ts
 * const router = new ReplicaRouter({
 *   primaryPool,
 *   replicaPool,
 *   lagThresholdMs: config.replicaLagThresholdMs,
 * });
 *
 * // Returns replica pool when healthy, primary pool otherwise.
 * const pool = await router.getReadPool();
 * ```
 */
export class ReplicaRouter {
  private readonly primary: pg.Pool;
  private readonly replica: pg.Pool | null;
  private readonly lagThresholdMs: number;
  /** true while replica lag is below threshold */
  private replicaHealthy = true;

  constructor(options: ReplicaPoolOptions) {
    this.primary = options.primaryPool;
    this.replica = options.replicaPool;
    this.lagThresholdMs = options.lagThresholdMs;
  }

  /**
   * Return the pool that should serve the next read query.
   *
   * Acquires a temporary client from the replica to run the lag probe, then
   * releases it immediately so it does not consume a long-lived connection.
   * Falls back to the primary when:
   *  - no replica is configured, or
   *  - the lag probe reports lag above threshold, or
   *  - the probe itself throws (network error, replica down, etc.).
   */
  async getReadPool(): Promise<pg.Pool> {
    if (!this.replica) return this.primary;

    let client: pg.PoolClient | undefined;
    try {
      client = await this.replica.connect();
      const health = await checkReplicaHealth(client, this.lagThresholdMs);

      if (health.healthy) {
        if (!this.replicaHealthy) {
          // Replica recovered — log and flip state.
          logger.info('Read replica recovered; resuming replica reads', undefined, {
            lagMs: health.lagMs,
            thresholdMs: this.lagThresholdMs,
          });
          this.replicaHealthy = true;
        }
        return this.replica;
      }

      // Replica is lagging or unavailable.
      if (this.replicaHealthy) {
        // First breach — log, count, and flip state.
        logger.warn('Read replica lag exceeds threshold; failing over to primary', undefined, {
          lagMs: health.lagMs,
          thresholdMs: this.lagThresholdMs,
          reason: health.reason,
        });
        replicaFailoversTotal.inc();
        this.replicaHealthy = false;
      } else {
        // Sustained lag — periodic alert without double-counting the counter.
        logger.warn('Read replica still lagging; reads remain on primary', undefined, {
          lagMs: health.lagMs,
          thresholdMs: this.lagThresholdMs,
          reason: health.reason,
        });
      }
    } catch (err) {
      logger.warn('Replica health check threw unexpectedly; using primary', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.replicaHealthy) {
        replicaFailoversTotal.inc();
        this.replicaHealthy = false;
      }
    } finally {
      client?.release();
    }

    return this.primary;
  }

  /** Expose current failover state (useful for health endpoints and tests). */
  isReplicaHealthy(): boolean {
    return this.replicaHealthy;
  }
}
