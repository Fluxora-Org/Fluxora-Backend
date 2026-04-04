/**
 * Rate Limiter for Job Queue
 *
 * Implements per-user rate limiting with multiple limit types:
 * - Job submission rate (e.g., 100 jobs/hour)
 * - Concurrent job limit (e.g., 10 concurrent jobs)
 * - Total queued job limit (e.g., 1000 queued jobs)
 * - Global queue depth limit (e.g., 100,000 total jobs)
 *
 * @module jobs/RateLimiter
 */

import { getDatabase } from "../db/connection.js";
import type { JobType } from "./types.js";
import { DEFAULT_JOB_CONFIGS } from "./types.js";

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum job submissions per user per hour */
  submissionRatePerHour: number;

  /** Maximum concurrent running jobs per user */
  maxConcurrentJobs: number;

  /** Maximum total queued jobs per user (PENDING + RUNNING + RETRYING) */
  maxQueuedJobs: number;

  /** Global maximum total jobs in the system */
  globalMaxJobs: number;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;

  /** Reason for denial if not allowed */
  reason?: string;

  /** Retry after seconds if rate limited */
  retryAfter?: number;

  /** Rate limit information */
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: number; // Unix timestamp
  };
}

/**
 * Rate limit error with retry information
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfter: number,
    public readonly rateLimit: {
      limit: number;
      remaining: number;
      reset: number;
    },
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  submissionRatePerHour: 100,
  maxConcurrentJobs: 10,
  maxQueuedJobs: 1000,
  globalMaxJobs: 100000,
};

/**
 * RateLimiter handles per-user and global rate limiting for job submissions
 */
export class RateLimiter {
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      ...DEFAULT_RATE_LIMIT_CONFIG,
      ...config,
    };
  }

  /**
   * Check if a job submission is allowed for a user
   *
   * @param userId - User identifier
   * @param jobType - Type of job being submitted
   * @returns Rate limit check result
   */
  checkRateLimit(userId: string, jobType: JobType): RateLimitResult {
    const db = getDatabase();

    // Check global queue depth limit
    const globalCount = this.getGlobalJobCount();
    if (globalCount >= this.config.globalMaxJobs) {
      return {
        allowed: false,
        reason: "Global queue depth limit exceeded",
        retryAfter: 60, // Retry after 1 minute
      };
    }

    // Check per-user total queued jobs limit
    const queuedCount = this.getUserQueuedJobCount(userId);
    if (queuedCount >= this.config.maxQueuedJobs) {
      return {
        allowed: false,
        reason: `User has reached maximum queued jobs limit (${this.config.maxQueuedJobs})`,
        retryAfter: 60, // Retry after 1 minute
      };
    }

    // Check per-user concurrent jobs limit
    const concurrentCount = this.getUserConcurrentJobCount(userId);
    if (concurrentCount >= this.config.maxConcurrentJobs) {
      return {
        allowed: false,
        reason: `User has reached maximum concurrent jobs limit (${this.config.maxConcurrentJobs})`,
        retryAfter: 30, // Retry after 30 seconds
      };
    }

    // Check per-user submission rate (jobs per hour)
    const submissionCount = this.getUserSubmissionCount(userId);
    const limit = this.getSubmissionRateLimit(jobType);
    const remaining = Math.max(0, limit - submissionCount);

    if (submissionCount >= limit) {
      // Calculate when the rate limit window resets
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const oldestJob = db
        .prepare(
          `SELECT created_at FROM jobs 
           WHERE user_id = ? 
           AND created_at > ? 
           ORDER BY created_at ASC 
           LIMIT 1`,
        )
        .get(userId, oneHourAgo.toISOString()) as
        | { created_at: string }
        | undefined;

      const resetTime = oldestJob
        ? new Date(oldestJob.created_at).getTime() + 60 * 60 * 1000
        : Date.now() + 60 * 60 * 1000;

      const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);

      return {
        allowed: false,
        reason: `User has exceeded job submission rate limit (${limit} per hour)`,
        retryAfter: Math.max(1, retryAfter),
        rateLimit: {
          limit,
          remaining: 0,
          reset: Math.floor(resetTime / 1000),
        },
      };
    }

    // Request is allowed
    return {
      allowed: true,
      rateLimit: {
        limit,
        remaining,
        reset: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
      },
    };
  }

  /**
   * Get submission rate limit for a job type
   *
   * @param jobType - Type of job
   * @returns Submission rate limit per hour
   */
  private getSubmissionRateLimit(jobType: JobType): number {
    const jobConfig = DEFAULT_JOB_CONFIGS[jobType];
    return jobConfig.rateLimit?.perUser ?? this.config.submissionRatePerHour;
  }

  /**
   * Get total number of jobs in the system
   *
   * @returns Global job count
   */
  private getGlobalJobCount(): number {
    const db = getDatabase();

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs 
         WHERE state IN ('PENDING', 'RUNNING', 'RETRYING')`,
      )
      .get() as { count: number };

    return result.count;
  }

  /**
   * Get number of queued jobs for a user (PENDING + RUNNING + RETRYING)
   *
   * @param userId - User identifier
   * @returns Queued job count
   */
  private getUserQueuedJobCount(userId: string): number {
    const db = getDatabase();

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs 
         WHERE user_id = ? 
         AND state IN ('PENDING', 'RUNNING', 'RETRYING')`,
      )
      .get(userId) as { count: number };

    return result.count;
  }

  /**
   * Get number of concurrent running jobs for a user
   *
   * @param userId - User identifier
   * @returns Concurrent job count
   */
  private getUserConcurrentJobCount(userId: string): number {
    const db = getDatabase();

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs 
         WHERE user_id = ? 
         AND state = 'RUNNING'`,
      )
      .get(userId) as { count: number };

    return result.count;
  }

  /**
   * Get number of jobs submitted by a user in the last hour
   *
   * @param userId - User identifier
   * @returns Submission count in the last hour
   */
  private getUserSubmissionCount(userId: string): number {
    const db = getDatabase();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM jobs 
         WHERE user_id = ? 
         AND created_at > ?`,
      )
      .get(userId, oneHourAgo.toISOString()) as { count: number };

    return result.count;
  }

  /**
   * Enforce rate limit and throw error if exceeded
   *
   * @param userId - User identifier
   * @param jobType - Type of job being submitted
   * @throws RateLimitError if rate limit is exceeded
   */
  enforceRateLimit(userId: string, jobType: JobType): void {
    const result = this.checkRateLimit(userId, jobType);

    if (!result.allowed) {
      throw new RateLimitError(
        result.reason || "Rate limit exceeded",
        result.retryAfter || 60,
        result.rateLimit || {
          limit: this.config.submissionRatePerHour,
          remaining: 0,
          reset: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
        },
      );
    }
  }
}
