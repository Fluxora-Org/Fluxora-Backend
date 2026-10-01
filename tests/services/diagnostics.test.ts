/**
 * Security contract tests for diagnostics output — issue #1445.
 * Dependency failures are deliberately hostile: their messages commonly embed
 * credentials and topology, and must not be echoed by a diagnostic response.
 */
import { describe, expect, it } from 'vitest';
import { DiagnosticsService } from '../../src/services/diagnostics.js';
import type pg from 'pg';

const DENY_LIST: RegExp[] = [
  /(?:postgres(?:ql)?|redis):\/\/\S+/i,
  /:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^,\s;]+/i,
  /\b[a-z0-9-]+\.(?:internal|local|cluster|svc|corp)\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{0,4}\b/i,
];

const hostileDependencyError = [
  'postgresql://service:db-password@db.internal:5432/fluxora',
  'redis://:redis-password@cache.cluster:6379/0',
  'Bearer diagnostic-secret-token',
  'api_key=sk_live_sensitive',
  '10.20.30.40',
  '2001:db8::1',
].join(' ');

describe('DiagnosticsService security (#1445)', () => {
  it('never returns secrets, credentials, or internal topology from failed checks', async () => {
    const pool = {
      connect: () => Promise.reject(new Error(hostileDependencyError)),
    } as unknown as pg.Pool;
    const service = new DiagnosticsService({
      getDbPool: () => pool,
      pingRedis: () => Promise.reject(new Error(hostileDependencyError)),
      getCircuitBreakerState: () => {
        throw new Error(hostileDependencyError);
      },
      getIndexerLagSeconds: () => {
        throw new Error(hostileDependencyError);
      },
    });

    const report = await service.runDiagnostics();
    const output = JSON.stringify(report);

    expect(report.dbPool).toMatchObject({ status: 'error', error: 'Database check failed' });
    expect(report.redis).toMatchObject({ status: 'error', error: 'Redis check failed' });
    expect(report.circuitBreaker).toMatchObject({
      status: 'error',
      error: 'Circuit breaker check failed',
    });
    expect(report.indexer).toMatchObject({ status: 'error', error: 'Indexer check failed' });
    for (const pattern of DENY_LIST) {
      expect(output).not.toMatch(pattern);
    }
  });

  it('retains timeout status while exposing no exception details', async () => {
    const service = new DiagnosticsService({
      checkTimeoutMs: 1,
      getDbPool: () =>
        ({
          connect: () => new Promise((resolve) => setTimeout(resolve, 20)),
        }) as unknown as pg.Pool,
      pingRedis: () => new Promise((resolve) => setTimeout(() => resolve(1), 20)),
      getCircuitBreakerState: () => ({
        state: 'CLOSED',
        transitionedAt: null,
        failureCount: 0,
        degraded: false,
      }),
      getIndexerLagSeconds: () => 0,
      getIndexerReplayProgress: () => ({ isReplaying: false, rowsReplayed: 0, totalRows: 0 }),
    });

    const report = await service.runDiagnostics();

    expect(report.redis).toMatchObject({ status: 'timeout', error: 'Redis check timed out' });
    expect(JSON.stringify(report)).not.toMatch(/timed out after \d+ms/);
  });
});
