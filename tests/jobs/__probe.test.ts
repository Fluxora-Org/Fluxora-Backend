import { describe, it, expect, vi } from 'vitest';

const scheduleCalls: Array<{ name: string; cron: string; opts: Record<string, unknown> }> = [];
const sendCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
const workOpts: Array<{ name: string; opts: Record<string, unknown> }> = [];

vi.mock('pg-boss', () => ({
  PgBoss: class {
    start = vi.fn();
    stop = vi.fn();
    send = vi.fn(async (name: string, _d: unknown, opts: Record<string, unknown>) => {
      sendCalls.push({ name, opts });
      return 'id';
    });
    schedule = vi.fn(
      async (name: string, cron: string, _d: unknown, opts: Record<string, unknown>) => {
        scheduleCalls.push({ name, cron, opts });
      },
    );
    work = vi.fn(async (name: string, opts: Record<string, unknown>) => {
      workOpts.push({ name, opts });
      return 'sub';
    });
    offWork = vi.fn();
  },
}));

vi.mock('../../src/db/pool.js', () => ({
  resolvePoolConfig: () => ({ connectionString: 'postgresql://localhost/test', max: 2 }),
  getPool: vi.fn(),
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/tracing/middleware.js', () => ({
  getCorrelationId: () => 'unknown',
  correlationStore: { run: vi.fn((_i: string, f: () => unknown) => f()) },
}));
vi.mock('../../src/tracing/hooks.js', () => ({ traceSpan: vi.fn((_a: string, _b: string, _c: unknown, f: () => unknown) => f()) }));
vi.mock('../../src/metrics/businessMetrics.js', () => ({ jobDlqEntriesTotal: { inc: vi.fn() } }));
vi.mock('../../src/metrics/jobMetrics.js', () => ({
  configureBackgroundJob: vi.fn(),
  recordBackgroundJobFailure: vi.fn(),
  recordBackgroundJobSuccess: vi.fn(),
}));

import { startBackgroundJobs, setJobQueue } from '../../src/jobs/queue.js';

describe('probe', () => {
  it('shows options forwarded to pg-boss', async () => {
    setJobQueue(null);
    startBackgroundJobs({ query: vi.fn() } as never);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    console.log('SCHEDULE CALLS:', JSON.stringify(scheduleCalls, null, 2));
    console.log('SEND CALLS:', JSON.stringify(sendCalls, null, 2));
    console.log('WORK OPTS:', JSON.stringify(workOpts, null, 2));
    expect(true).toBe(true);
  });
});
