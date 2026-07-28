import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobQueue } from '../../src/jobs/queue.ts';
import type { Job } from 'pg-boss';

// ── Mocks ─────────────────────────────────────────────────────────────────

function createMockBoss() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue('worker-id'),
    offWork: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('job-id-123'),
    schedule: vi.fn().mockResolvedValue(undefined),
  };
}

type MockBoss = ReturnType<typeof createMockBoss>;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-id',
    name: 'test-queue',
    data: { foo: 'bar' },
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('JobQueue', () => {
  let mockBoss: MockBoss;
  let queue: JobQueue;

  beforeEach(() => {
    mockBoss = createMockBoss();
    queue = JobQueue.withBoss(mockBoss as never);
  });

  afterEach(async () => {
    await queue.stop();
  });

  describe('constructor / withBoss', () => {
    it('creates a queue with a mock boss', () => {
      expect(queue).toBeInstanceOf(JobQueue);
      expect(queue.isStarted).toBe(false);
    });
  });

  describe('register', () => {
    it('registers a handler by name', () => {
      const handler = vi.fn();
      queue.register('my-job', handler);
      // Handler is lazy — it's only wired to boss on start()
      expect(queue.isStarted).toBe(false);
    });

    it('registers a handler with options', () => {
      const handler = vi.fn();
      queue.register('my-job', handler, { retryLimit: 5, retryDelay: 30 });
      expect(queue.isStarted).toBe(false);
    });
  });

  describe('start', () => {
    it('calls boss.start() and boss.work() for each registered handler', async () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      queue.register('queue-a', handlerA, { retryLimit: 3 });
      queue.register('queue-b', handlerB);
      await queue.start();

      expect(mockBoss.start).toHaveBeenCalledTimes(1);
      expect(mockBoss.work).toHaveBeenCalledTimes(2);
      expect(mockBoss.work).toHaveBeenNthCalledWith(1, 'queue-a', {}, expect.any(Function));
      expect(mockBoss.work).toHaveBeenNthCalledWith(2, 'queue-b', {}, expect.any(Function));
      expect(queue.isStarted).toBe(true);
    });

    it('is idempotent — calling start() twice only starts once', async () => {
      queue.register('q', vi.fn());
      await queue.start();
      await queue.start();
      expect(mockBoss.start).toHaveBeenCalledTimes(1);
      expect(mockBoss.work).toHaveBeenCalledTimes(1);
    });

    it('dispatches work handler when job arrives', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.register('test-q', handler);

      await queue.start();

      const workFn = mockBoss.work.mock.calls[0][2];
      await workFn([makeJob()]);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        id: 'test-job-id',
        name: 'test-q',
        data: { foo: 'bar' },
      });
    });

    it('re-throws handler errors for pg-boss retry mechanism', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('oops'));
      queue.register('test-q', handler);

      await queue.start();

      const workFn = mockBoss.work.mock.calls[0][2];
      await expect(workFn([makeJob()])).rejects.toThrow('oops');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('passes work options correctly', async () => {
      queue.register('q', vi.fn(), {
        localConcurrency: 3,
        pollingIntervalSeconds: 2,
      });

      await queue.start();

      expect(mockBoss.work).toHaveBeenCalledWith(
        'q',
        expect.objectContaining({
          localConcurrency: 3,
          pollingIntervalSeconds: 2,
        }),
        expect.any(Function),
      );
    });
  });

  describe('send', () => {
    it('delegates to boss.send with correct arguments', async () => {
      const jobId = await queue.send('test-queue', { key: 'value' }, { priority: 1 });
      expect(jobId).toBe('job-id-123');
      expect(mockBoss.send).toHaveBeenCalledWith(
        'test-queue',
        { key: 'value' },
        expect.objectContaining({ priority: 1 }),
      );
    });

    it('sends without options', async () => {
      await queue.send('test-queue', { key: 'value' });
      expect(mockBoss.send).toHaveBeenCalledWith('test-queue', { key: 'value' }, {});
    });

    it('passes send options correctly', async () => {
      await queue.send('test-queue', { x: 1 }, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 300,
        deadLetter: 'dlq',
        singletonKey: 'key-1',
        singletonSeconds: 30,
        priority: 5,
      });

      expect(mockBoss.send).toHaveBeenCalledWith('test-queue', { x: 1 }, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 300,
        deadLetter: 'dlq',
        singletonKey: 'key-1',
        singletonSeconds: 30,
        priority: 5,
      });
    });
  });

  describe('schedule', () => {
    it('delegates to boss.schedule with cron expression', async () => {
      await queue.schedule('test-queue', '0 * * * *', { key: 'value' }, { tz: 'UTC' });
      expect(mockBoss.schedule).toHaveBeenCalledWith(
        'test-queue',
        '0 * * * *',
        { key: 'value' },
        expect.objectContaining({ tz: 'UTC' }),
      );
    });

    it('schedules without data', async () => {
      await queue.schedule('test-queue', '0 0 * * *');
      expect(mockBoss.schedule).toHaveBeenCalledWith('test-queue', '0 0 * * *', null, {});
    });
  });

  describe('stop', () => {
    it('calls boss.offWork and boss.stop', async () => {
      queue.register('q', vi.fn());
      await queue.start();
      expect(queue.isStarted).toBe(true);

      await queue.stop();

      expect(mockBoss.offWork).toHaveBeenCalledWith('q');
      expect(mockBoss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 30000 });
      expect(queue.isStarted).toBe(false);
    });

    it('is safe to call when not started', async () => {
      await expect(queue.stop()).resolves.toBeUndefined();
    });
  });
});

// ── Singleton tests ───────────────────────────────────────────────────────

describe('JobQueue singleton', () => {
  beforeEach(async () => {
    const { setJobQueue } = await import('../../src/jobs/queue.js');
    setJobQueue(null);
  });

  it('getJobQueue returns null before set', async () => {
    const { getJobQueue } = await import('../../src/jobs/queue.js');
    expect(getJobQueue()).toBeNull();
  });

  it('setJobQueue stores the queue instance', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockBoss = createMockBoss();
    const q = mod.JobQueue.withBoss(mockBoss as never);
    mod.setJobQueue(q);
    expect(mod.getJobQueue()).toBe(q);
  });

  it('setJobQueue(null) clears the singleton', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockBoss = createMockBoss();
    const q = mod.JobQueue.withBoss(mockBoss as never);
    mod.setJobQueue(q);
    expect(mod.getJobQueue()).toBe(q);
    mod.setJobQueue(null);
    expect(mod.getJobQueue()).toBeNull();
  });
});

// ── stopBackgroundJobs tests ──────────────────────────────────────────────

describe('stopBackgroundJobs', () => {
  beforeEach(async () => {
    const { setJobQueue } = await import('../../src/jobs/queue.js');
    setJobQueue(null);
  });

  it('stops the queue and clears the singleton when a queue is set', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockBoss = createMockBoss();
    const q = mod.JobQueue.withBoss(mockBoss as never);
    // Register and start so workSubscriptions is populated
    q.register('test-job', vi.fn());
    await q.start();
    expect(q.isStarted).toBe(true);
    mod.setJobQueue(q);

    await mod.stopBackgroundJobs();

    expect(mockBoss.offWork).toHaveBeenCalledWith('test-job');
    expect(mockBoss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 30000 });
    expect(mod.getJobQueue()).toBeNull();
  });

  it('handles the case when no queue is set gracefully', async () => {
    const mod = await import('../../src/jobs/queue.js');
    mod.setJobQueue(null);

    // Should not throw when no queue exists
    await expect(mod.stopBackgroundJobs()).resolves.toBeUndefined();
    expect(mod.getJobQueue()).toBeNull();
  });

  it('handles stop errors gracefully without throwing', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockBoss = createMockBoss();
    mockBoss.stop.mockRejectedValueOnce(new Error('stop failed'));
    const q = mod.JobQueue.withBoss(mockBoss as never);
    q.register('test-job', vi.fn());
    await q.start();
    mod.setJobQueue(q);

    // Should not throw even when boss.stop() rejects
    await expect(mod.stopBackgroundJobs()).resolves.toBeUndefined();
    // Singleton should still be cleared
    expect(mod.getJobQueue()).toBeNull();
  });
});

// ── startBackgroundJobs tests ─────────────────────────────────────────────

describe('startBackgroundJobs', () => {
  beforeEach(async () => {
    const { setJobQueue } = await import('../../src/jobs/queue.js');
    setJobQueue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Boot startBackgroundJobs and extract the raw DLQ handler function. */
  async function getDlqHandler(mockPool: { query: ReturnType<typeof vi.fn> }) {
    const mod = await import('../../src/jobs/queue.js');
    const registerSpy = vi.spyOn(mod.JobQueue.prototype, 'register');
    vi.spyOn(mod.JobQueue.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'schedule').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'send').mockResolvedValue(null);
    mod.startBackgroundJobs(mockPool as never);
    const call = registerSpy.mock.calls.find((c) => c[0] === 'job_dead_letter_queue');
    return call![1];
  }

  // ── exported constants ────────────────────────────────────────────────────

  it('exports DEFAULT_RETRY_LIMIT as a positive integer', async () => {
    const { DEFAULT_RETRY_LIMIT } = await import('../../src/jobs/queue.js');
    expect(typeof DEFAULT_RETRY_LIMIT).toBe('number');
    expect(DEFAULT_RETRY_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_RETRY_LIMIT)).toBe(true);
  });

  it('exports DEFAULT_RETRY_DELAY as a positive integer', async () => {
    const { DEFAULT_RETRY_DELAY } = await import('../../src/jobs/queue.js');
    expect(typeof DEFAULT_RETRY_DELAY).toBe('number');
    expect(DEFAULT_RETRY_DELAY).toBeGreaterThan(0);
  });

  it('exports DEFAULT_RETRY_BACKOFF as a boolean', async () => {
    const { DEFAULT_RETRY_BACKOFF } = await import('../../src/jobs/queue.js');
    expect(typeof DEFAULT_RETRY_BACKOFF).toBe('boolean');
  });

  it('exports DEFAULT_EXPIRE_SECONDS as a positive integer', async () => {
    const { DEFAULT_EXPIRE_SECONDS } = await import('../../src/jobs/queue.js');
    expect(typeof DEFAULT_EXPIRE_SECONDS).toBe('number');
    expect(DEFAULT_EXPIRE_SECONDS).toBeGreaterThan(0);
  });

  // ── handler registration ─────────────────────────────────────────────────

  it('registers partition-maintenance and job_dead_letter_queue handlers', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const registerSpy = vi.spyOn(mod.JobQueue.prototype, 'register');
    const startSpy = vi.spyOn(mod.JobQueue.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'schedule').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'send').mockResolvedValue(null);

    mod.startBackgroundJobs(mockPool as never);

    expect(registerSpy).toHaveBeenCalledWith(
      'partition-maintenance',
      expect.any(Function),
      expect.any(Object),
    );
    expect(registerSpy).toHaveBeenCalledWith('job_dead_letter_queue', expect.any(Function));
    expect(startSpy).toHaveBeenCalled();
  });

  it('registers partition-maintenance with the exported default constants', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const registerSpy = vi.spyOn(mod.JobQueue.prototype, 'register');
    vi.spyOn(mod.JobQueue.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'schedule').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'send').mockResolvedValue(null);

    mod.startBackgroundJobs(mockPool as never);

    const pmCall = registerSpy.mock.calls.find((c) => c[0] === 'partition-maintenance');
    expect(pmCall![2]).toMatchObject({
      retryLimit: mod.DEFAULT_RETRY_LIMIT,
      retryDelay: mod.DEFAULT_RETRY_DELAY,
      retryBackoff: mod.DEFAULT_RETRY_BACKOFF,
      expireInSeconds: mod.DEFAULT_EXPIRE_SECONDS,
      deadLetter: mod.DEAD_LETTER_QUEUE,
    });
  });

  it('is idempotent — calling startBackgroundJobs twice skips the second call', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const registerSpy = vi.spyOn(mod.JobQueue.prototype, 'register');
    vi.spyOn(mod.JobQueue.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'schedule').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'send').mockResolvedValue(null);

    mod.startBackgroundJobs(mockPool as never);
    const countAfterFirst = registerSpy.mock.calls.length;
    mod.startBackgroundJobs(mockPool as never);
    // No additional register calls on second invocation
    expect(registerSpy.mock.calls.length).toBe(countAfterFirst);
  });

  // ── DLQ handler: happy path ───────────────────────────────────────────────

  it('DLQ handler: persists a well-formed payload to job_dead_letter', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: {
        name: 'original-job',
        id: 'orig-123',
        data: { foo: 'bar' },
        output: 'Some error occurred',
        retryCount: 3,
      },
    } as never);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO job_dead_letter'),
      ['original-job', 'orig-123', { foo: 'bar' }, 'Some error occurred', 3],
    );
  });

  it('DLQ handler: extracts error from output.message when output is an object', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: {
        name: 'some-job',
        id: 'job-456',
        output: { message: 'DB connection refused' },
        retryCount: 2,
      },
    } as never);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO job_dead_letter'),
      ['some-job', 'job-456', null, 'DB connection refused', 2],
    );
  });

  it('DLQ handler: JSON-stringifies unknown output shapes', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: {
        name: 'some-job',
        id: 'job-789',
        output: { code: 500, detail: 'oops' },
        retryCount: 1,
      },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(JSON.stringify({ code: 500, detail: 'oops' }));
  });

  // ── DLQ handler: retryCount edge cases ───────────────────────────────────

  it('DLQ handler: preserves retryCount of 0 (does not treat falsy 0 as missing)', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-1', retryCount: 0 },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe(0);
  });

  it('DLQ handler: reads retrycount (lowercase) when retryCount is absent', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-2', retrycount: 5 },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe(5);
  });

  it('DLQ handler: defaults retryCount to 0 when both keys are absent', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-3' },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe(0);
  });

  // ── DLQ handler: missing / null / non-string name/id ─────────────────────

  it('DLQ handler: falls back to "unknown" for missing job name', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { id: 'some-id' },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('unknown');
  });

  it('DLQ handler: falls back to "unknown" for missing job id', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'some-job' },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe('unknown');
  });

  it('DLQ handler: handles null ctx.data without throwing', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await expect(
      dlqHandler({ id: 'dlq-ctx-id', name: 'job_dead_letter_queue', data: null } as never),
    ).resolves.toBeUndefined();

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('unknown');
    expect(params[1]).toBe('unknown');
    expect(params[4]).toBe(0);
  });

  it('DLQ handler: handles non-object ctx.data without throwing', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await expect(
      dlqHandler({ id: 'dlq-ctx-id', name: 'job_dead_letter_queue', data: 'bad' } as never),
    ).resolves.toBeUndefined();

    expect(mockPool.query).toHaveBeenCalled();
  });

  // ── DLQ handler: DB insert failure resilience ─────────────────────────────

  it('DLQ handler: does NOT re-throw when the DB insert fails', async () => {
    const mockPool = { query: vi.fn().mockRejectedValue(new Error('connection lost')) };
    const dlqHandler = await getDlqHandler(mockPool);

    // Must resolve, not reject — pg-boss must not retry a terminal DLQ job
    await expect(
      dlqHandler({
        id: 'dlq-ctx-id',
        name: 'job_dead_letter_queue',
        data: { name: 'j', id: 'id-x', retryCount: 1, output: 'err' },
      } as never),
    ).resolves.toBeUndefined();
  });

  it('DLQ handler: still increments the metric even when the DB insert fails', async () => {
    const { jobDlqEntriesTotal } = await import('../../src/metrics/businessMetrics.js');
    const incSpy = vi.spyOn(jobDlqEntriesTotal, 'inc');

    const mockPool = { query: vi.fn().mockRejectedValue(new Error('timeout')) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'failing-job', id: 'id-y', retryCount: 2, output: 'timeout' },
    } as never);

    expect(incSpy).toHaveBeenCalledWith({ job_name: 'failing-job' });
  });

  // ── DLQ handler: observability ────────────────────────────────────────────

  it('DLQ handler: increments jobDlqEntriesTotal with the correct job_name label', async () => {
    const { jobDlqEntriesTotal } = await import('../../src/metrics/businessMetrics.js');
    const incSpy = vi.spyOn(jobDlqEntriesTotal, 'inc');

    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'partition-maintenance', id: 'pm-1', retryCount: 3, output: 'disk full' },
    } as never);

    expect(incSpy).toHaveBeenCalledWith({ job_name: 'partition-maintenance' });
  });

  it('DLQ handler: uses "unknown" as job_name label when name is absent', async () => {
    const { jobDlqEntriesTotal } = await import('../../src/metrics/businessMetrics.js');
    const incSpy = vi.spyOn(jobDlqEntriesTotal, 'inc');

    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { id: 'no-name-job' },
    } as never);

    expect(incSpy).toHaveBeenCalledWith({ job_name: 'unknown' });
  });

  // ── DLQ handler: empty‑string name/id fields ──────────────────────────────

  it('DLQ handler: falls back to "unknown" for empty‑string job name', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: '', id: 'orig-1' },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('unknown');
  });

  it('DLQ handler: falls back to "unknown" for empty‑string job id', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'some-job', id: '' },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe('unknown');
  });

  // ── DLQ handler: both retrycount (lower) and retryCount (camel) ──────────

  it('DLQ handler: prefers retrycount (lowercase) when both keys are present', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-both', retrycount: 7, retryCount: 3 },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe(7);
  });

  // ── DLQ handler: output as non‑message object ────────────────────────────

  it('DLQ handler: JSON‑stringifies output object without a message field', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-arr', output: ['array', 'error'] },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(JSON.stringify(['array', 'error']));
  });

  it('DLQ handler: JSON‑stringifies output when it is a number', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-num', output: 42 },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe('42');
  });

  // ── DLQ handler: output.message as non‑string value ──────────────────────

  it('DLQ handler: falls through to JSON.stringify when output.message is not a string', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-msg', output: { message: 99 } },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(JSON.stringify({ message: 99 }));
  });

  // ── DLQ handler: retryCount 0 when both keys are non‑numeric ─────────────

  it('DLQ handler: defaults to 0 when retrycount is non‑numeric', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const dlqHandler = await getDlqHandler(mockPool);

    await dlqHandler({
      id: 'dlq-ctx-id',
      name: 'job_dead_letter_queue',
      data: { name: 'j', id: 'id-nn', retrycount: 'bad' },
    } as never);

    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe(0);
  });
});

// ── DEAD_LETTER_QUEUE constant ────────────────────────────────────────────

describe('DEAD_LETTER_QUEUE', () => {
  it('exports a non‑empty string constant', async () => {
    const { DEAD_LETTER_QUEUE } = await import('../../src/jobs/queue.js');
    expect(typeof DEAD_LETTER_QUEUE).toBe('string');
    expect(DEAD_LETTER_QUEUE.length).toBeGreaterThan(0);
  });

  it('is the queue name used by partition‑maintenance registration', async () => {
    const mod = await import('../../src/jobs/queue.js');
    expect(mod.DEAD_LETTER_QUEUE).toBe('job_dead_letter_queue');
  });
});

// ── DEFAULT_DLQ_RETENTION_DAYS constant ──────────────────────────────────

describe('DEFAULT_DLQ_RETENTION_DAYS', () => {
  it('exports a positive integer', async () => {
    const { DEFAULT_DLQ_RETENTION_DAYS } = await import('../../src/jobs/queue.js');
    expect(typeof DEFAULT_DLQ_RETENTION_DAYS).toBe('number');
    expect(DEFAULT_DLQ_RETENTION_DAYS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_DLQ_RETENTION_DAYS)).toBe(true);
  });
});

// ── Validation: register ─────────────────────────────────────────────────

describe('JobQueue – register validation', () => {
  let mockBoss: ReturnType<typeof createMockBoss>;
  let queue: JobQueue;

  beforeEach(() => {
    mockBoss = createMockBoss();
    queue = JobQueue.withBoss(mockBoss as never);
  });

  it('throws TypeError for empty string name', () => {
    expect(() => queue.register('', vi.fn())).toThrow(TypeError);
  });

  it('throws TypeError for whitespace‑only name', () => {
    expect(() => queue.register('   ', vi.fn())).toThrow(TypeError);
  });

  it('throws TypeError for non‑string name', () => {
    expect(() => queue.register(123 as never, vi.fn())).toThrow(TypeError);
  });

  it('throws TypeError when handler is not a function', () => {
    expect(() => queue.register('valid-name', null as never)).toThrow(TypeError);
    expect(() => queue.register('valid-name', undefined as never)).toThrow(TypeError);
    expect(() => queue.register('valid-name', 'not-a-fn' as never)).toThrow(TypeError);
  });

  it('does NOT throw for valid arguments', () => {
    expect(() => queue.register('valid-name', vi.fn())).not.toThrow();
  });
});

// ── Validation: send ─────────────────────────────────────────────────────

describe('JobQueue – send validation', () => {
  let mockBoss: ReturnType<typeof createMockBoss>;
  let queue: JobQueue;

  beforeEach(() => {
    mockBoss = createMockBoss();
    queue = JobQueue.withBoss(mockBoss as never);
  });

  it('throws TypeError for empty string name', async () => {
    await expect(queue.send('', {})).rejects.toThrow(TypeError);
  });

  it('throws TypeError for whitespace‑only name', async () => {
    await expect(queue.send('   ', {})).rejects.toThrow(TypeError);
  });

  it('throws TypeError for non‑string name', async () => {
    await expect(queue.send(123 as never, {})).rejects.toThrow(TypeError);
  });

  it('does NOT throw for valid arguments', async () => {
    await expect(queue.send('valid-name', { foo: 'bar' })).resolves.toBe('job-id-123');
  });
});

// ── Validation: schedule ─────────────────────────────────────────────────

describe('JobQueue – schedule validation', () => {
  let mockBoss: ReturnType<typeof createMockBoss>;
  let queue: JobQueue;

  beforeEach(() => {
    mockBoss = createMockBoss();
    queue = JobQueue.withBoss(mockBoss as never);
  });

  it('throws TypeError for empty string name', async () => {
    await expect(queue.schedule('', '0 * * * *')).rejects.toThrow(TypeError);
  });

  it('throws TypeError for empty string cron', async () => {
    await expect(queue.schedule('my-job', '')).rejects.toThrow(TypeError);
  });

  it('throws TypeError for whitespace‑only cron', async () => {
    await expect(queue.schedule('my-job', '   ')).rejects.toThrow(TypeError);
  });

  it('does NOT throw for valid arguments', async () => {
    await expect(queue.schedule('my-job', '0 * * * *')).resolves.toBeUndefined();
  });
});

// ── Validation: toSendOptions ────────────────────────────────────────────

describe('JobQueue – toSendOptions validation', () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = JobQueue.withBoss(createMockBoss() as never);
  });

  it('throws TypeError for negative retryLimit', async () => {
    await expect(queue.send('test', {}, { retryLimit: -1 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError for NaN retryLimit', async () => {
    await expect(queue.send('test', {}, { retryLimit: NaN })).rejects.toThrow(TypeError);
  });

  it('throws TypeError for negative retryDelay', async () => {
    await expect(queue.send('test', {}, { retryDelay: -5 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError for negative expireInSeconds', async () => {
    await expect(queue.send('test', {}, { expireInSeconds: -1 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError for empty deadLetter string', async () => {
    await expect(queue.send('test', {}, { deadLetter: '' })).rejects.toThrow(TypeError);
  });

  it('passes retryDelayMax to boss.send', async () => {
    const mockBoss = createMockBoss();
    const q = JobQueue.withBoss(mockBoss as never);
    await q.send('test', {}, { retryDelayMax: 300 });
    expect(mockBoss.send).toHaveBeenCalledWith(
      'test',
      {},
      expect.objectContaining({ retryDelayMax: 300 }),
    );
  });

  it('passes startAfter as a Date object', async () => {
    const mockBoss = createMockBoss();
    const q = JobQueue.withBoss(mockBoss as never);
    const future = new Date(Date.now() + 3600000);
    await q.send('test', {}, { startAfter: future });
    expect(mockBoss.send).toHaveBeenCalledWith(
      'test',
      {},
      expect.objectContaining({ startAfter: future }),
    );
  });

  it('passes startAfter as a number (Unix seconds)', async () => {
    const mockBoss = createMockBoss();
    const q = JobQueue.withBoss(mockBoss as never);
    await q.send('test', {}, { startAfter: 3600 });
    expect(mockBoss.send).toHaveBeenCalledWith(
      'test',
      {},
      expect.objectContaining({ startAfter: 3600 }),
    );
  });
});

// ── purgeJobDeadLetter ───────────────────────────────────────────────────

describe('purgeJobDeadLetter', () => {
  it('executes DELETE with default retention days', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 5 }) };
    const deleted = await mod.purgeJobDeadLetter(mockPool as never);
    expect(deleted).toBe(5);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM job_dead_letter'),
      [mod.DEFAULT_DLQ_RETENTION_DAYS],
    );
  });

  it('executes DELETE with custom retention days', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 3 }) };
    const deleted = await mod.purgeJobDeadLetter(mockPool as never, 30);
    expect(deleted).toBe(3);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM job_dead_letter'),
      [30],
    );
  });

  it('returns 0 when no rows match', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    const deleted = await mod.purgeJobDeadLetter(mockPool as never, 7);
    expect(deleted).toBe(0);
  });

  it('throws for null pool', async () => {
    const mod = await import('../../src/jobs/queue.js');
    await expect(mod.purgeJobDeadLetter(null)).rejects.toThrow('requires a valid PostgreSQL pool');
  });

  it('throws for negative retentionDays', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn() };
    await expect(mod.purgeJobDeadLetter(mockPool as never, -1)).rejects.toThrow(TypeError);
  });

  it('throws for NaN retentionDays', async () => {
    const mod = await import('../../src/jobs/queue.js');
    const mockPool = { query: vi.fn() };
    await expect(mod.purgeJobDeadLetter(mockPool as never, NaN)).rejects.toThrow(TypeError);
  });
});

// ── DLQ retention purge integration in partition maintenance ──────────────

describe('partition-maintenance DLQ purge integration', () => {
  beforeEach(async () => {
    const { setJobQueue } = await import('../../src/jobs/queue.js');
    setJobQueue(null);
    vi.restoreAllMocks();
  });

  /** Extract the partition‑maintenance handler registered by startBackgroundJobs. */
  async function getPmHandler(mockPool: { query: ReturnType<typeof vi.fn> }) {
    const mod = await import('../../src/jobs/queue.js');
    const registerSpy = vi.spyOn(mod.JobQueue.prototype, 'register');
    vi.spyOn(mod.JobQueue.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'schedule').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'send').mockResolvedValue(null);
    mod.startBackgroundJobs(mockPool as never);
    const call = registerSpy.mock.calls.find((c) => c[0] === 'partition-maintenance');
    return { handler: call![1], mod };
  }

  it('calls purgeJobDeadLetter during partition-maintenance handler', async () => {
    // First query returns advisory-lock success; all subsequent queries
    // return empty rows (table not managed, advisory unlock, DLQ purge).
    const mockPool = { query: vi.fn() };
    mockPool.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }], rowCount: 1 });
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const { handler, mod } = await getPmHandler(mockPool);

    await handler({ id: 'pm-test', name: 'partition-maintenance', data: {} } as never);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM job_dead_letter'),
      [mod.DEFAULT_DLQ_RETENTION_DAYS],
    );
  });

  it('does not throw when partition-maintenance DLQ purge fails', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    mockPool.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }], rowCount: 1 });

    const { handler, mod } = await getPmHandler(mockPool);
    vi.spyOn(mod, 'purgeJobDeadLetter').mockRejectedValue(new Error('DB down'));

    // Must not throw — DLQ purge errors are swallowed
    await expect(
      handler({ id: 'pm-test', name: 'partition-maintenance', data: {} } as never),
    ).resolves.toBeUndefined();
  });
});
