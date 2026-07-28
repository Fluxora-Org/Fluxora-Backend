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

  it('registers partition-maintenance and job_dead_letter_queue handlers', async () => {
    const mod = await import('../../src/jobs/queue.js');
    
    // We mock Pool
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    } as any;

    // Spy on register, start, schedule, send
    const registerSpy = vi.spyOn(mod.JobQueue.prototype, 'register');
    const startSpy = vi.spyOn(mod.JobQueue.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'schedule').mockResolvedValue(undefined);
    vi.spyOn(mod.JobQueue.prototype, 'send').mockResolvedValue(null);
    
    mod.startBackgroundJobs(mockPool);

    expect(registerSpy).toHaveBeenCalledWith('partition-maintenance', expect.any(Function), expect.any(Object));
    expect(registerSpy).toHaveBeenCalledWith('job_dead_letter_queue', expect.any(Function));
    expect(startSpy).toHaveBeenCalled();

    // Verify DLQ handler behavior
    const dlqCall = registerSpy.mock.calls.find(c => c[0] === 'job_dead_letter_queue');
    const dlqHandler = dlqCall![1];

    const dlqCtx = {
      id: 'dlq-id',
      name: 'job_dead_letter_queue',
      data: {
        name: 'original-job',
        id: 'orig-123',
        data: { foo: 'bar' },
        output: 'Some error occurred',
        retryCount: 3,
      }
    };

    await dlqHandler(dlqCtx as any);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO job_dead_letter'),
      ['original-job', 'orig-123', { foo: 'bar' }, 'Some error occurred', 3]
    );
  });
});
