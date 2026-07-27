import { type Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import type {
  ConstructorOptions,
  Job,
} from 'pg-boss';
import { logger } from '../lib/logger.js';
import { resolvePoolConfig } from '../db/pool.js';
import { runPartitionMaintenance } from './partitionMaintenance.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface JobHandlerContext {
  id: string;
  name: string;
  data: unknown;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;

export interface JobRegistrationOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  expireInSeconds?: number;
  deadLetter?: string;
  pollingIntervalSeconds?: number;
  localConcurrency?: number;
}

export interface JobSendOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  expireInSeconds?: number;
  deadLetter?: string;
  startAfter?: number | string | Date;
  singletonKey?: string;
  singletonSeconds?: number;
  priority?: number;
}

export interface JobScheduleOptions extends JobSendOptions {
  tz?: string;
  key?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_RETRY_DELAY = 60;
const DEFAULT_RETRY_BACKOFF = true;
const DEFAULT_EXPIRE_SECONDS = 900;
const DEAD_LETTER_QUEUE = 'job_dead_letter_queue';

// ── JobQueue ──────────────────────────────────────────────────────────────

export class JobQueue {
  private boss: InstanceType<typeof PgBoss>;
  private handlers = new Map<string, { handler: JobHandler; options: JobRegistrationOptions }>();
  private _started = false;
  private workSubscriptions: string[] = [];

  constructor(pool: Pool) {
    const cfg = resolvePoolConfig();
    const bossOptions: ConstructorOptions = {
      connectionString: cfg.connectionString,
      schema: 'pgboss',
      ...(cfg.max ? { max: Math.max(2, Math.min(cfg.max, 4)) } : { max: 2 }),
    };
    this.boss = new PgBoss(bossOptions);
  }

  static withBoss(boss: InstanceType<typeof PgBoss>): JobQueue {
    const queue = new JobQueue({} as Pool);
    queue.boss = boss;
    return queue;
  }

  register(name: string, handler: JobHandler, options: JobRegistrationOptions = {}): void {
    this.handlers.set(name, { handler, options });
  }

  async start(): Promise<void> {
    if (this._started) return;
    await this.boss.start();
    for (const [name, reg] of this.handlers) {
      const workOpts: Record<string, unknown> = {};
      if (reg.options.localConcurrency !== undefined) workOpts.localConcurrency = reg.options.localConcurrency;
      if (reg.options.pollingIntervalSeconds !== undefined) workOpts.pollingIntervalSeconds = reg.options.pollingIntervalSeconds;
      await this.boss.work(name, workOpts, async (jobs: Job[]) => {
        for (const job of jobs) {
          try {
            const ctx: JobHandlerContext = { id: job.id, name, data: job.data };
            await reg.handler(ctx);
          } catch (err) {
            logger.error('Job handler failed', undefined, {
              jobName: name,
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        }
      });
      this.workSubscriptions.push(name);
    }
    this._started = true;
    logger.info('Job queue started', undefined, {
      queues: this.workSubscriptions,
    });
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    for (const name of this.workSubscriptions) {
      await this.boss.offWork(name).catch(() => {});
    }
    this.workSubscriptions = [];
    await this.boss.stop({ graceful: true, timeout: 30000 });
    this._started = false;
    logger.info('Job queue stopped');
  }

  async send(name: string, data: unknown, options?: JobSendOptions): Promise<string | null> {
    const sendOpts = this.toSendOptions(options);
    return this.boss.send(name, data as object | null, sendOpts);
  }

  async schedule(name: string, cron: string, data?: unknown, options?: JobScheduleOptions): Promise<void> {
    const schedOpts: Record<string, unknown> = {
      ...this.toSendOptions(options),
      ...(options?.tz ? { tz: options.tz } : {}),
      ...(options?.key ? { key: options.key } : {}),
    };
    return this.boss.schedule(name, cron, (data ?? null) as object | null, schedOpts);
  }

  get isStarted(): boolean {
    return this._started;
  }

  private toSendOptions(opts?: JobSendOptions): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (!opts) return s;
    if (opts.retryLimit !== undefined) s.retryLimit = opts.retryLimit;
    if (opts.retryDelay !== undefined) s.retryDelay = opts.retryDelay;
    if (opts.retryBackoff !== undefined) s.retryBackoff = opts.retryBackoff;
    if (opts.retryDelayMax !== undefined) s.retryDelayMax = opts.retryDelayMax;
    if (opts.expireInSeconds !== undefined) s.expireInSeconds = opts.expireInSeconds;
    if (opts.deadLetter !== undefined) s.deadLetter = opts.deadLetter;
    if (opts.startAfter !== undefined) s.startAfter = opts.startAfter;
    if (opts.singletonKey !== undefined) s.singletonKey = opts.singletonKey;
    if (opts.singletonSeconds !== undefined) s.singletonSeconds = opts.singletonSeconds;
    if (opts.priority !== undefined) s.priority = opts.priority;
    return s;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _jobQueue: JobQueue | null = null;

export function getJobQueue(): JobQueue | null {
  return _jobQueue;
}

export function setJobQueue(queue: JobQueue | null): void {
  _jobQueue = queue;
}

// ── Background jobs bootstrap (backward compatible) ───────────────────────

/**
 * Initializes and schedules background jobs using the pg-boss-backed JobQueue.
 *
 * Keeps the existing signature so callers in `src/app.ts` continue to work.
 * Should be called once at startup with the application's Postgres pool.
 */
export function startBackgroundJobs(pool: Pool): void {
  if (_jobQueue) {
    logger.warn('Background jobs already started, skipping duplicate init');
    return;
  }
  const queue = new JobQueue(pool);
  setJobQueue(queue);

  queue.register(
    'partition-maintenance',
    async (ctx) => {
      logger.info('Running partition maintenance job', undefined, { jobId: ctx.id });
      await runPartitionMaintenance(pool);
    },
    {
      retryLimit: DEFAULT_RETRY_LIMIT,
      retryDelay: DEFAULT_RETRY_DELAY,
      retryBackoff: DEFAULT_RETRY_BACKOFF,
      expireInSeconds: DEFAULT_EXPIRE_SECONDS,
      deadLetter: DEAD_LETTER_QUEUE,
    },
  );

  queue.register(
    DEAD_LETTER_QUEUE,
    async (ctx) => {
      const payload = ctx.data as any;
      const originalJobName = payload?.name || 'unknown';
      const originalJobId = payload?.id || 'unknown';
      const originalPayload = payload?.data ?? null;
      let errorMessage = 'Unknown error';
      if (payload?.output) {
        if (typeof payload.output === 'string') errorMessage = payload.output;
        else if (payload.output.message) errorMessage = payload.output.message;
        else errorMessage = JSON.stringify(payload.output);
      }
      
      const retryCount = payload?.retrycount || payload?.retryCount || 0;

      logger.error('Job permanently failed and moved to DLQ', undefined, {
        jobName: originalJobName,
        jobId: originalJobId,
        error: errorMessage,
      });

      await pool.query(
        `INSERT INTO job_dead_letter (job_name, job_id, payload, error_message, retry_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          originalJobName,
          originalJobId,
          originalPayload,
          errorMessage,
          retryCount,
        ]
      );
    }
  );

  queue.start().catch((err: Error) => {
    logger.error('Failed to start job queue', undefined, { error: err.message });
  });

  queue
    .schedule('partition-maintenance', '0 0 * * *', undefined, {
      retryLimit: DEFAULT_RETRY_LIMIT,
      retryDelay: DEFAULT_RETRY_DELAY,
      retryBackoff: DEFAULT_RETRY_BACKOFF,
      expireInSeconds: DEFAULT_EXPIRE_SECONDS,
    })
    .catch((err: Error) => {
      logger.error('Failed to schedule partition maintenance', undefined, { error: err.message });
    });

  queue.send('partition-maintenance', {}, {
    retryLimit: DEFAULT_RETRY_LIMIT,
    retryDelay: DEFAULT_RETRY_DELAY,
    retryBackoff: DEFAULT_RETRY_BACKOFF,
    expireInSeconds: DEFAULT_EXPIRE_SECONDS,
    deadLetter: DEAD_LETTER_QUEUE,
  }).catch((err: Error) => {
    logger.error('Failed to enqueue startup partition maintenance', undefined, { error: err.message });
  });
}

/**
 * Stops background jobs and clears the singleton JobQueue instance.
 *
 * Matches the `vacuumCollector.ts` pattern where a paired stop function is
 * exported alongside the start function. Safe to call multiple times.
 */
export async function stopBackgroundJobs(): Promise<void> {
  const queue = getJobQueue();
  if (!queue) {
    logger.warn('No background jobs to stop — queue was never started');
    return;
  }
  try {
    await queue.stop();
    logger.info('Background jobs stopped');
  } catch (err) {
    logger.error('Failed to stop background jobs', undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always clear the singleton so subsequent shutdown hooks
    // or tests can detect the queue is no longer active.
    setJobQueue(null);
  }
}
