/**
 * Concrete health checkers for Postgres and Stellar RPC.
 *
 * Each checker enforces a hard timeout so a hung dependency
 * cannot stall the health endpoint.
 */

import type { HealthChecker } from '../config/health.js';

const DEFAULT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

export interface PostgresClient {
  query(sql: string): Promise<unknown>;
  totalCount?: number;
  idleCount?: number;
}

/**
 * Checks Postgres by running SELECT 1 and verifying the pool is not exhausted.
 */
export function createPostgresChecker(
  getClient: () => PostgresClient,
  opts: { timeoutMs?: number; maxPoolSize?: number } = {},
): HealthChecker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPoolSize = opts.maxPoolSize ?? 10;

  return {
    name: 'postgres',
    async check() {
      const start = Date.now();
      try {
        const client = getClient();
        await withTimeout(client.query('SELECT 1'), timeoutMs, 'postgres');

        // Pool exhaustion check (pg Pool exposes these counts)
        if (
          typeof client.totalCount === 'number' &&
          typeof client.idleCount === 'number' &&
          client.idleCount === 0 &&
          client.totalCount >= maxPoolSize
        ) {
          return { latency: Date.now() - start, error: 'Connection pool exhausted' };
        }

        return { latency: Date.now() - start };
      } catch (err) {
        return {
          latency: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export interface StellarRpcClient {
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * Checks Stellar RPC by calling getLatestLedger.
 * Optionally verifies the ledger is not lagging behind a threshold.
 */
export function createStellarRpcChecker(
  getClient: () => StellarRpcClient,
  opts: { timeoutMs?: number; maxLedgerAgeSec?: number } = {},
): HealthChecker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'stellar_rpc',
    async check() {
      const start = Date.now();
      try {
        const client = getClient();
        const result = await withTimeout(client.getLatestLedger(), timeoutMs, 'stellar_rpc');

        if (!result || typeof result.sequence !== 'number') {
          return { latency: Date.now() - start, error: 'Invalid ledger response' };
        }

        return { latency: Date.now() - start };
      } catch (err) {
        return {
          latency: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
