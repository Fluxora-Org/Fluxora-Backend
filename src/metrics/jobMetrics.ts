import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';

export const BACKGROUND_JOB_NAMES = [
  'queue',
  'partition-maintenance',
  'retention-purge',
  'dead-letter-purge',
] as const;

export type BackgroundJobName = (typeof BACKGROUND_JOB_NAMES)[number];

const lastSuccess = new Map<BackgroundJobName, number>();
const expectedIntervals = new Map<BackgroundJobName, number>();

export const backgroundJobLastSuccessTimestampSeconds =
  (registry.getSingleMetric(
    'fluxora_background_job_last_success_timestamp_seconds'
  ) as Gauge<'job'>) ||
  new Gauge({
    name: 'fluxora_background_job_last_success_timestamp_seconds',
    help: 'Unix timestamp of the last successful background job run',
    labelNames: ['job'] as const,
    registers: [registry],
  });

export const backgroundJobExpectedIntervalSeconds =
  (registry.getSingleMetric('fluxora_background_job_expected_interval_seconds') as Gauge<'job'>) ||
  new Gauge({
    name: 'fluxora_background_job_expected_interval_seconds',
    help: 'Expected maximum interval between successful background job runs',
    labelNames: ['job'] as const,
    registers: [registry],
  });

export const backgroundJobStale =
  (registry.getSingleMetric('fluxora_background_job_stale') as Gauge<'job'>) ||
  new Gauge({
    name: 'fluxora_background_job_stale',
    help: 'Whether a background job has exceeded its expected interval (1 stale, 0 healthy)',
    labelNames: ['job'] as const,
    registers: [registry],
  });

export const backgroundJobDurationSeconds =
  (registry.getSingleMetric('fluxora_background_job_duration_seconds') as Histogram<
    'job' | 'outcome'
  >) ||
  new Histogram({
    name: 'fluxora_background_job_duration_seconds',
    help: 'Duration of background job runs in seconds',
    labelNames: ['job', 'outcome'] as const,
    buckets: [0.01, 0.1, 0.5, 1, 5, 15, 30, 60, 300],
    registers: [registry],
  });

export const backgroundJobFailuresTotal =
  (registry.getSingleMetric('fluxora_background_job_failures_total') as Counter<'job'>) ||
  new Counter({
    name: 'fluxora_background_job_failures_total',
    help: 'Total number of failed background job runs',
    labelNames: ['job'] as const,
    registers: [registry],
  });

for (const job of BACKGROUND_JOB_NAMES) {
  backgroundJobStale.set({ job }, 1);
}

export function configureBackgroundJob(
  job: BackgroundJobName,
  expectedIntervalSeconds: number
): void {
  if (!Number.isFinite(expectedIntervalSeconds) || expectedIntervalSeconds <= 0) {
    throw new RangeError('expectedIntervalSeconds must be a positive finite number');
  }
  expectedIntervals.set(job, expectedIntervalSeconds);
  backgroundJobExpectedIntervalSeconds.set({ job }, expectedIntervalSeconds);
}

export function recordBackgroundJobSuccess(
  job: BackgroundJobName,
  durationSeconds: number,
  nowSeconds = Date.now() / 1000
): void {
  lastSuccess.set(job, nowSeconds);
  backgroundJobLastSuccessTimestampSeconds.set({ job }, nowSeconds);
  backgroundJobStale.set({ job }, 0);
  backgroundJobDurationSeconds.observe({ job, outcome: 'success' }, Math.max(0, durationSeconds));
}

export function recordBackgroundJobFailure(job: BackgroundJobName, durationSeconds: number): void {
  backgroundJobFailuresTotal.inc({ job });
  backgroundJobDurationSeconds.observe({ job, outcome: 'failure' }, Math.max(0, durationSeconds));
}

export function refreshBackgroundJobStaleness(nowSeconds = Date.now() / 1000): void {
  for (const job of BACKGROUND_JOB_NAMES) {
    const expectedInterval = expectedIntervals.get(job);
    const lastRun = lastSuccess.get(job);
    backgroundJobStale.set(
      { job },
      expectedInterval === undefined ||
        lastRun === undefined ||
        nowSeconds - lastRun > expectedInterval
        ? 1
        : 0
    );
  }
}

(backgroundJobStale as any).collect = async () => {
  refreshBackgroundJobStaleness();
};
