import { type Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import type {
  ConstructorOptions,
  Job,
} from 'pg-boss';
import { logger } from '../lib/logger.js';
import { resolvePoolConfig } from '../db/pool.js';
import { runPartitionMaintenance } from './partitionMaintenance.js';

/**
 * JobHandlerContext – context passed to job handlers.
 *
 * @param id - Unique identifier for the job instance.
 * @param name - Name of the job (registered key).
 * @param data - Unknown data passed from the scheduler.
 */
export interface JobHandlerContext {
  id: string;
  name: string;
  data: unknown;
}

/**
 * JobHandler – signature for job processing functions.
 *
 * @param ctx - Context containing job ID, name, and data.
 * @returns Promise that resolves when the job completes, or rejects on error.
 */
export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;

/**
 * Options used when registering a job.
 *
 * @param retryLimit - Maximum number of retry attempts before moving to dead‑letter.
 * @param retryDelay - Base delay in seconds between retries.
 * @param retryBackoff - Whether to use exponential backoff (default true).
 * @param retryDelayMax - Upper bound for backoff delay.
 * @param expireInSeconds - Maximum time a job may stay active before being auto‑expired.
 * @param deadLetter - Name of the dead‑letter queue to which failed jobs are routed.
 * @param pollingIntervalSeconds - Custom polling interval for this job (overrides default).
 * @param localConcurrency - Limit concurrency for this job (overrides default).
 */
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

/**
 * Options used when sending a job immediately.
 *
 * @param retryLimit - Max retries before dead‑letter.
 * @param retryDelay - Base delay for retries.
 * @param retryBackoff - Enable exponential backoff.
 * @param retryDelayMax - Max backoff delay.
 * @param expireInSeconds - Job expiration time.
 * @param deadLetter - Queue name to route terminally‑failed jobs to.
 * @param startAfter - Optional delay before job becomes visible.
 * @param singletonKey - Key for singleton jobs.
 * @param singletonSeconds - Seconds a singleton job remains active.
 * @param priority - Priority of the job (higher = earlier).
 */
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

/**
 * Options used when scheduling a job via cron.
 *
 * Extends `JobSendOptions` with scheduling‑specific fields.
 */
export interface JobScheduleOptions extends JobSendOptions {
  tz?: string;
  key?: string;
}

/**
 * JobQueue – pg‑boss backed job queue.
 *
 * Provides a durable, at‑least‑once job processing system with:
 *   • Exponential backoff retry
 *   • Configurable dead‑letter queue
 *   • Cron scheduling
 *   • Singleton accessor
 *
 * All jobs are executed within a PostgreSQL transaction provided by pg‑boss,
 * ensuring consistency with the rest of the application's data.
 */
export class JobQueue {
  private boss: InstanceType<typeof PgBoss>;
  private handlers = new Map<string, { handler: JobHandler; options: JobRegistrationOptions }>();
  private _started = false;
  private workSubscriptions: string[] = [];

  /**
   * Creates a new JobQueue instance bound to a Postgres pool.
   *
   * @param pool - The application's PostgreSQL connection pool.
   */
  constructor(pool: Pool) {
    const cfg = resolvePoolConfig();
    const bossOptions: ConstructorOptions = {
      connectionString: cfg.connectionString,
      schema: 'pgboss',
      ...(cfg.max ? { max: Math.max(2, Math.min(cfg.max, 4)) } : { max: 2 }),
    };
    this.boss = new PgBoss(bossOptions);
  }

  /**
   * Creates a JobQueue instance from an existing pg‑boss boss object.
   *
   * @param boss - An already‑initialized PgBoss instance.
   */
  static withBoss(boss: InstanceType<typeof PgBoss>): JobQueue {
    const queue = new JobQueue({} as Pool);
    queue.boss = boss;
    return queue;
  }

  /**
   * Registers a job handler by name.
   *
   * @param name - Unique identifier for the job (used for scheduling and logging).
   * @param handler - Function that receives a JobHandlerContext and performs the job logic.
   *                Must be async and may throw to trigger retries.
   * @param options - Optional configuration for retry behavior, expiration, dead‑letter routing,
   *                  and other job‑specific settings.
   *
   * The handler is called for each job fetched from the queue. Errors are caught,
   * logged, and re‑thrown to allow pg‑boss to retry according to the supplied options.
   */
  register(name: string, handler: JobHandler, options: JobRegistrationOptions = {}): void {
    this.handlers.set(name, { handler, options });
  }

  /**
   * Starts the job queue, establishing connections and registering work handlers.
   *
   * This method is idempotent – calling it multiple times will not duplicate workers.
   * It logs when the queue starts and which jobs are registered.
   */
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

  /**
   * Stops the job queue, gracefully shutting down all workers and releasing resources.
   *
   * This method is safe to call multiple times; it will no‑op if the queue is already stopped.
   */
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

  /**
   * Sends a job to the queue.
   *
   * @param name - Job name (must match a registered handler).
   * @param data - Serializable job payload.
   * @param options - Optional job options such as retry limits, dead‑letter routing, and expiration.
   * @returns The job ID if the job was successfully queued, or `null` if not.
   *
   * The function respects the `deadLetter` option; if the job later fails all retries,
   * it will be moved to the configured dead‑letter queue.
   */
  async send(name: string, data: unknown, options?: JobSendOptions): Promise<string | null> {
    const sendOpts = this.toSendOptions(options);
    return this.boss.send(name, data as object | null, sendOpts);
  }

  /**
   * Schedules a job to run according to a cron expression.
   *
   * @param name - Job name (must match a registered handler).
   * @param cron - Cron expression defining the schedule.
   * @param data - Optional job payload.
   * @param options - Job options (retry, dead‑letter, etc.).
   *
   * The job will be executed according to the cron schedule. If the job throws,
   * pg‑boss will apply the retry configuration before eventually moving it to the dead‑letter queue.
   */
  async schedule(name: string, cron: string, data?: unknown, options?: JobScheduleOptions): Promise<void> {
    const schedOpts: Record<string, unknown> = {
      ...this.toSendOptions(options),
      ...(options?.tz ? { tz: options.tz } : {}),
      ...(options?.key ? { key: options.key } : {}),
    };
    return this.boss.schedule(name, cron, (data ?? null) as object | null, schedOpts);
  }

  /**
   * Indicates whether the job queue has been started.
   */
  get isStarted(): boolean {
    return this._started;
  }

  /**
   * Converts `JobSendOptions` into the shape expected by pg‑boss.
   *
   * Maps the supplied options to pg‑boss configuration keys.
   */
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

/**
 * Singleton accessor for the JobQueue.
 *
 * The singleton is set during application startup via `setJobQueue`.
 */
let _jobQueue: JobQueue | null = null;

export function getJobQueue(): JobQueue | null {
  return _jobQueue;
}

export function setJobQueue(queue: JobQueue | null): void {
  _jobQueue = queue;
}

/**
 * Initializes and schedules background jobs using the pg‑boss-backed JobQueue.
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

  queue.start().catch((err: Error) => {
    logger.error('Failed to start job queue', undefined, { error: err.message });
  });

  queue
    .schedule('partition-maintenance', '0 0 * * *', undefined, {
      retryLimit: DEFAULT_RETRY_LIMIT,
      retryDelay: DEFAULT_RETRY_DELAY,
      retryBackoff: DEFAULT_RETRY_BACKOFF,
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
 * Safe to call multiple times; will no‑op if no queue is active.
 *
 * Logs the stop event and any errors that occur during shutdown.
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

/**
 * Constant used for the dead‑letter queue name.
 *
 * pg‑boss routes jobs that exceed their retry limit to this queue.
 */
export const DEAD_LETTER_QUEUE = 'job_dead_letter_queue';