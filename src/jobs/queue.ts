import { type Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import type {
  ConstructorOptions,
  Job,
} from 'pg-boss';
import { logger } from '../lib/logger.js';
import { resolvePoolConfig } from '../db/pool.js';
import { runPartitionMaintenance } from './partitionMaintenance.js';
import { runDlqPurge } from './dlqPurge.js';
import { jobDlqEntriesTotal } from '../metrics/businessMetrics.js';

// ── Retry / expiry defaults ───────────────────────────────────────────────────
//
// Exported so callers (and tests) can reference the canonical values without
// repeating magic numbers.  All are intentionally conservative to bound blast
// radius on runaway workers.

/**
 * Maximum number of retry attempts before a job is moved to the dead‑letter
 * queue.  Three attempts ≈ a brief transient failure without hammering the DB.
 */
export const DEFAULT_RETRY_LIMIT = 3;

/**
 * Base retry delay in seconds (used as the fixed interval when backoff is
 * disabled, or as the seed when exponential backoff is enabled).
 */
export const DEFAULT_RETRY_DELAY = 30;

/**
 * Whether to apply exponential backoff between retry attempts.
 * `true` ⇒ each attempt waits 2^n × `retryDelay` seconds.
 */
export const DEFAULT_RETRY_BACKOFF = true;

/**
 * Maximum time in seconds a job may remain in the `active` state before
 * pg‑boss automatically moves it back to `failed`.  15 minutes is generous
 * for the maintenance workload and protects against hung workers.
 */
export const DEFAULT_EXPIRE_SECONDS = 900; // 15 minutes

// ── Internal types ────────────────────────────────────────────────────────────

/**
 * Shape of the data payload that pg‑boss attaches to a job when it routes it
 * to the dead‑letter queue.  The fields come directly from pg‑boss internals;
 * all are optional because pg‑boss does not guarantee their presence.
 *
 * @internal
 */
interface DlqJobPayload {
  /** Original job name as registered with pg‑boss. */
  name?: unknown;
  /** Original job ID (UUID). */
  id?: unknown;
  /** Application‑level data the job was created with. */
  data?: unknown;
  /**
   * Error output captured when the job exceeded its retry limit.
   * May be a plain string, an `{ message: string }` object, or arbitrary JSON.
   */
  output?: unknown;
  /**
   * pg‑boss stores the retry count as `retrycount` (lowercase) in older
   * versions and `retryCount` (camelCase) in newer ones.  We normalise both.
   */
  retrycount?: unknown;
  retryCount?: unknown;
}

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
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('register: name must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('register: handler must be a function');
    }
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
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('send: name must be a non-empty string');
    }
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
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('schedule: name must be a non-empty string');
    }
    if (typeof cron !== 'string' || cron.trim() === '') {
      throw new TypeError('schedule: cron must be a non-empty string');
    }
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
    if (opts.retryLimit !== undefined) {
      if (typeof opts.retryLimit !== 'number' || !Number.isFinite(opts.retryLimit) || opts.retryLimit < 0) {
        throw new TypeError('toSendOptions: retryLimit must be a non-negative finite number');
      }
      s.retryLimit = opts.retryLimit;
    }
    if (opts.retryDelay !== undefined) {
      if (typeof opts.retryDelay !== 'number' || !Number.isFinite(opts.retryDelay) || opts.retryDelay < 0) {
        throw new TypeError('toSendOptions: retryDelay must be a non-negative finite number');
      }
      s.retryDelay = opts.retryDelay;
    }
    if (opts.retryBackoff !== undefined) s.retryBackoff = opts.retryBackoff;
    if (opts.retryDelayMax !== undefined) {
      if (typeof opts.retryDelayMax !== 'number' || !Number.isFinite(opts.retryDelayMax) || opts.retryDelayMax < 0) {
        throw new TypeError('toSendOptions: retryDelayMax must be a non-negative finite number');
      }
      s.retryDelayMax = opts.retryDelayMax;
    }
    if (opts.expireInSeconds !== undefined) {
      if (typeof opts.expireInSeconds !== 'number' || !Number.isFinite(opts.expireInSeconds) || opts.expireInSeconds < 0) {
        throw new TypeError('toSendOptions: expireInSeconds must be a non-negative finite number');
      }
      s.expireInSeconds = opts.expireInSeconds;
    }
    if (opts.deadLetter !== undefined) {
      if (typeof opts.deadLetter !== 'string' || opts.deadLetter.trim() === '') {
        throw new TypeError('toSendOptions: deadLetter must be a non-empty string');
      }
      s.deadLetter = opts.deadLetter;
    }
    if (opts.startAfter !== undefined) s.startAfter = opts.startAfter;
    if (opts.singletonKey !== undefined) s.singletonKey = opts.singletonKey;
    if (opts.singletonSeconds !== undefined) {
      if (typeof opts.singletonSeconds !== 'number' || !Number.isFinite(opts.singletonSeconds) || opts.singletonSeconds < 0) {
        throw new TypeError('toSendOptions: singletonSeconds must be a non-negative finite number');
      }
      s.singletonSeconds = opts.singletonSeconds;
    }
    if (opts.priority !== undefined) {
      if (typeof opts.priority !== 'number' || !Number.isFinite(opts.priority)) {
        throw new TypeError('toSendOptions: priority must be a finite number');
      }
      s.priority = opts.priority;
    }
    return s;
  }
}

/**
 * Constant used for the dead‑letter queue name.
 *
 * pg‑boss routes jobs that exceed their retry limit to this queue.
 */
export const DEAD_LETTER_QUEUE = 'job_dead_letter_queue';

/**
 * Maximum byte-length for persisted `error_message` in job_dead_letter.
 * Prevents oversized error strings from blowing the TEXT column budget.
 */
export const DLQ_MAX_ERROR_BYTES = 2048;

/**
 * Maximum byte-length for the serialised `payload` stored in job_dead_letter.
 * pg JSONB can hold large documents, but we cap this to avoid runaway rows.
 */
export const DLQ_MAX_PAYLOAD_BYTES = 65536; // 64 KiB

/**
 * Safely truncates a UTF‑8 string to fit within `maxBytes` without breaking
 * multi‑byte character boundaries.  Returns the original string if it already
 * fits within the limit.
 *
 * @internal
 */
function truncateUtf8(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;
  let truncated = '';
  for (const char of str) {
    const next = truncated + char;
    if (Buffer.byteLength(next, 'utf-8') > maxBytes) break;
    truncated = next;
  }
  return truncated;
}

/**
 * Default retention period in days for `job_dead_letter` entries.
 * Entries older than this are eligible for purging by the partition‑maintenance
 * job.  90 days keeps enough history for post‑mortem analysis while bounding
 * table growth.
 */
export const DEFAULT_DLQ_RETENTION_DAYS = 90;

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
 *
 * @throws {Error} If `pool` is null or undefined — callers must supply a valid pool.
 */
export function startBackgroundJobs(pool: Pool): void {
  // Guard: a missing pool is a programming error that would cause a silent crash
  // inside the DLQ handler when pool.query is eventually called.
  if (pool == null) {
    throw new Error('startBackgroundJobs requires a valid PostgreSQL pool');
  }
  if (typeof pool.query !== 'function') {
    throw new TypeError('startBackgroundJobs: pool must expose a query method');
  }

  if (_jobQueue) {
    logger.warn('Background jobs already started, skipping duplicate init');
    return;
  }
  const queue = new JobQueue(pool);
  setJobQueue(queue);

  queue.register(
    'partition-maintenance',
    async (ctx) => {
      logger.info('Running partition maintenance job', ctx.id, { jobId: ctx.id });
      const result = await runPartitionMaintenance(pool, { correlationId: ctx.id });
      logger.info('Partition maintenance job finished', ctx.id, {
        lockAcquired: result.lockAcquired,
        tables: result.tables.map((t) => ({
          table: t.table,
          managed: t.managed,
          created: t.partitionsCreated.length,
          behindSchedule: t.behindSchedule,
        })),
      });

      // Purge expired dead‑letter entries alongside the daily maintenance
      // to keep the DLQ table size bounded without a dedicated cron.
      try {
        const deleted = await purgeJobDeadLetter(pool, DEFAULT_DLQ_RETENTION_DAYS);
        if (deleted > 0) {
          logger.info('DLQ retention purge removed entries', ctx.id, { deletedCount: deleted });
        }
      } catch (dlqErr) {
        logger.error('DLQ retention purge failed, continuing', ctx.id, {
          error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
        });
      }

      // Purge terminal-state dead_letter_queue entries beyond retention window.
      try {
        const dlqResult = await runDlqPurge({ correlationId: ctx.id });
        if (dlqResult.rowsPurged > 0) {
          logger.info('DLQ retention purge: cleared terminal dead_letter_queue entries', ctx.id, {
            rowsPurged: dlqResult.rowsPurged,
            cutoffDate: dlqResult.cutoffDate,
          });
        }
      } catch (dlqPurgeErr) {
        logger.error('DLQ retention purge of dead_letter_queue failed, continuing', ctx.id, {
          error: dlqPurgeErr instanceof Error ? dlqPurgeErr.message : String(dlqPurgeErr),
        });
      }
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
      // pg-boss delivers the original job's metadata as ctx.data when routing
      // to a dead-letter queue.  We use the DlqJobPayload interface to make
      // the extraction explicit and type-safe rather than casting to `any`.
      const payload: DlqJobPayload =
        ctx.data !== null && typeof ctx.data === 'object'
          ? (ctx.data as DlqJobPayload)
          : {};

      // Use nullish coalescing (??) so that an explicit empty-string value
      // from pg-boss is preserved rather than being coerced to 'unknown' the
      // way the || operator would behave.
      const originalJobName =
        typeof payload.name === 'string' && payload.name !== '' ? payload.name : 'unknown';
      const originalJobId =
        typeof payload.id === 'string' && payload.id !== '' ? payload.id : 'unknown';
      const originalPayload = payload.data ?? null;

      let errorMessage = 'Unknown error';
      if (payload.output !== undefined && payload.output !== null) {
        if (typeof payload.output === 'string') {
          errorMessage = payload.output;
        } else if (
          typeof payload.output === 'object' &&
          'message' in payload.output &&
          typeof (payload.output as Record<string, unknown>).message === 'string'
        ) {
          errorMessage = (payload.output as Record<string, unknown>).message as string;
        } else {
          errorMessage = JSON.stringify(payload.output);
        }
      }

      // Normalise retrycount / retryCount: both keys must be coerced to a
      // number, and we default to 0 only when both are absent or non-numeric.
      // We use ?? (not ||) so that a legitimate value of 0 is not discarded.
      const rawRetry = payload.retrycount ?? payload.retryCount;
      const retryCount =
        typeof rawRetry === 'number' && Number.isFinite(rawRetry) ? rawRetry : 0;

      logger.error('Job permanently failed and moved to DLQ', ctx.id, {
        jobName: originalJobName,
        jobId: originalJobId,
        retryCount,
        error: errorMessage,
      });

      // Apply size budgets before persisting, so oversized entries don't
      // cause INSERT failures or bloat the dead‑letter table.
      const finalErrorMessage = truncateUtf8(errorMessage, DLQ_MAX_ERROR_BYTES);

      let finalPayload: unknown = originalPayload;
      if (finalPayload !== null) {
        try {
          const payloadJson = JSON.stringify(finalPayload);
          if (Buffer.byteLength(payloadJson, 'utf-8') > DLQ_MAX_PAYLOAD_BYTES) {
            finalPayload = { _truncated: true };
          }
        } catch {
          finalPayload = { _truncated: true };
        }
      }

      // Increment the observable counter so on-call can alert on DLQ growth.
      jobDlqEntriesTotal.inc({ job_name: originalJobName });

      // Persist to job_dead_letter.  Wrap in try/catch so that a transient DB
      // failure does NOT cause pg-boss to requeue this DLQ entry (which would
      // create a confusing retry loop on a terminal event).
      try {
        await pool.query(
          `INSERT INTO job_dead_letter (job_name, job_id, payload, error_message, retry_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [originalJobName, originalJobId, finalPayload, finalErrorMessage, retryCount],
        );
      } catch (insertErr) {
        // Log but do not re-throw: the job is terminally failed.  A failed
        // DLQ insert is surfaced via the error log and the metric above; the
        // pg-boss job itself will still be marked as completed (not retried).
        logger.error('Failed to persist DLQ entry to job_dead_letter', ctx.id, {
          jobName: originalJobName,
          jobId: originalJobId,
          error: insertErr instanceof Error ? insertErr.message : String(insertErr),
        });
      }
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
 * Purges expired entries from the `job_dead_letter` table.
 *
 * Deletes rows whose `failed_at` timestamp is older than `retentionDays`.
 * This prevents unbounded growth of the dead-letter table while keeping
 * recent entries available for post-mortem analysis.
 *
 * The function is called automatically by the partition-maintenance job;
 * callers should not normally need to invoke it directly.
 *
 * @param pool - PostgreSQL pool to query against.
 * @param retentionDays - Age threshold in days (defaults to `DEFAULT_DLQ_RETENTION_DAYS`).
 * @returns The number of deleted rows.
 *
 * @throws {Error} If `pool` is null or the query fails.
 */
export async function purgeJobDeadLetter(
  pool: Pool,
  retentionDays: number = DEFAULT_DLQ_RETENTION_DAYS,
): Promise<number> {
  if (pool == null) {
    throw new Error('purgeJobDeadLetter requires a valid PostgreSQL pool');
  }
  if (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new TypeError('purgeJobDeadLetter: retentionDays must be a non-negative finite number');
  }

  const result = await pool.query(
    `DELETE FROM job_dead_letter WHERE failed_at < NOW() - INTERVAL '1 day' * $1`,
    [retentionDays],
  );

  const deletedCount = result.rowCount ?? 0;
  logger.info('DLQ retention purge complete', undefined, {
    deletedCount,
    retentionDays,
  });
  return deletedCount;
}