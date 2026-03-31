/**
 * Unit tests for RateLimiter
 *
 * Tests rate limiting functionality including:
 * - Per-user submission rate limits
 * - Concurrent job limits
 * - Queue depth limits
 * - Global queue limits
 * - Rate limit headers
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { RateLimiter } from "../src/jobs/RateLimiter.js";
import { JobManager } from "../src/jobs/JobManager.js";
import Database from "better-sqlite3";
import * as dbConnection from "../src/db/connection.js";

// Test database
let testDb: Database.Database;

beforeAll(async () => {
  // Create in-memory database for testing
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");

  // Run the jobs migration
  const { up } = await import("../src/db/migrations/002_create_jobs_tables.js");
  testDb.exec(up);

  // Mock getDatabase to return our test database
  vi.spyOn(dbConnection, "getDatabase").mockReturnValue(testDb);
});

afterAll(() => {
  testDb.close();
  vi.restoreAllMocks();
});

describe("RateLimiter", () => {
  let rateLimiter: RateLimiter;
  let jobManager: JobManager;

  beforeAll(() => {
    rateLimiter = new RateLimiter();
    jobManager = new JobManager();
  });

  describe("Submission Rate Limiting", () => {
    it("should allow jobs within submission rate limit", () => {
      const result = rateLimiter.checkRateLimit("user1", "stream-sync");

      expect(result.allowed).toBe(true);
      expect(result.rateLimit).toBeDefined();
      expect(result.rateLimit?.limit).toBe(100); // stream-sync default
      expect(result.rateLimit?.remaining).toBe(100);
    });

    it("should enforce submission rate limit after exceeding", () => {
      // Create 100 jobs (the limit for stream-sync)
      for (let i = 0; i < 100; i++) {
        jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      // 101st job should be rate limited
      const result = rateLimiter.checkRateLimit("user1", "stream-sync");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeded job submission rate limit");
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.rateLimit?.remaining).toBe(0);
    });

    it("should use job-type-specific rate limits", () => {
      // event-sync has a limit of 50 per hour
      const result = rateLimiter.checkRateLimit("user1", "event-sync");

      expect(result.allowed).toBe(true);
      expect(result.rateLimit?.limit).toBe(50);
    });

    it("should track rate limits per user independently", () => {
      // Create 100 jobs for user1
      for (let i = 0; i < 100; i++) {
        jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      // user1 should be rate limited
      const result1 = rateLimiter.checkRateLimit("user1", "stream-sync");
      expect(result1.allowed).toBe(false);

      // user2 should not be rate limited
      const result2 = rateLimiter.checkRateLimit("user2", "stream-sync");
      expect(result2.allowed).toBe(true);
    });
  });

  describe("Concurrent Job Limiting", () => {
    it("should allow jobs within concurrent limit", () => {
      // Create 5 RUNNING jobs (limit is 10)
      for (let i = 0; i < 5; i++) {
        const job = jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
        jobManager.updateJobState(job.id, { state: "RUNNING" });
      }

      const result = rateLimiter.checkRateLimit("user1", "stream-sync");
      expect(result.allowed).toBe(true);
    });

    it("should enforce concurrent job limit", () => {
      // Create 10 RUNNING jobs (the limit)
      for (let i = 0; i < 10; i++) {
        const job = jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
        jobManager.updateJobState(job.id, { state: "RUNNING" });
      }

      const result = rateLimiter.checkRateLimit("user1", "stream-sync");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("concurrent jobs limit");
      expect(result.retryAfter).toBe(30);
    });

    it("should not count completed jobs toward concurrent limit", () => {
      // Create 10 RUNNING jobs
      for (let i = 0; i < 10; i++) {
        const job = jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
        jobManager.updateJobState(job.id, { state: "RUNNING" });
      }

      // Complete 5 of them
      const jobs = jobManager.listJobs({ user_id: "user1", state: "RUNNING" }, { limit: 5, offset: 0 });
      jobs.jobs.forEach((job) => {
        jobManager.updateJobState(job.id, { state: "COMPLETED" });
      });

      // Should now allow new jobs (5 running < 10 limit)
      const result = rateLimiter.checkRateLimit("user1", "stream-sync");
      expect(result.allowed).toBe(true);
    });
  });

  describe("Queue Depth Limiting", () => {
    it("should allow jobs within queue depth limit", () => {
      // Create 500 PENDING jobs (limit is 1000)
      for (let i = 0; i < 500; i++) {
        jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      const result = rateLimiter.checkRateLimit("user1", "stream-sync");
      expect(result.allowed).toBe(true);
    });

    it("should enforce queue depth limit", () => {
      // Create 1000 PENDING jobs (the limit)
      for (let i = 0; i < 1000; i++) {
        jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      const result = rateLimiter.checkRateLimit("user1", "stream-sync");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("queued jobs limit");
      expect(result.retryAfter).toBe(60);
    });

    it("should count PENDING, RUNNING, and RETRYING jobs in queue depth", () => {
      // Create mix of job states
      for (let i = 0; i < 300; i++) {
        jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      for (let i = 0; i < 300; i++) {
        const job = jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i + 300 },
        });
        jobManager.updateJobState(job.id, { state: "RUNNING" });
      }

      for (let i = 0; i < 400; i++) {
        const job = jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i + 600 },
        });
        jobManager.updateJobState(job.id, { state: "RUNNING" });
        jobManager.updateJobState(job.id, { state: "FAILED" });
        jobManager.updateJobState(job.id, { state: "RETRYING" });
      }

      // Total: 300 PENDING + 300 RUNNING + 400 RETRYING = 1000 (at limit)
      const result = rateLimiter.checkRateLimit("user1", "stream-sync");
      expect(result.allowed).toBe(false);
    });
  });

  describe("Global Queue Limiting", () => {
    it("should enforce global queue depth limit", () => {
      const customLimiter = new RateLimiter({
        globalMaxJobs: 10, // Set low limit for testing
      });

      // Create 10 jobs across multiple users
      for (let i = 0; i < 10; i++) {
        jobManager.createJob({
          user_id: `user${i}`,
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      const result = customLimiter.checkRateLimit("new-user", "stream-sync");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Global queue depth limit");
      expect(result.retryAfter).toBe(60);
    });
  });

  describe("Custom Configuration", () => {
    it("should accept custom rate limit configuration", () => {
      const customLimiter = new RateLimiter({
        submissionRatePerHour: 50,
        maxConcurrentJobs: 5,
        maxQueuedJobs: 100,
        globalMaxJobs: 1000,
      });

      // Should use custom submission rate
      const result = customLimiter.checkRateLimit("user1", "stream-sync");
      expect(result.rateLimit?.limit).toBe(100); // Job type config takes precedence
    });

    it("should use default values for unspecified config", () => {
      const customLimiter = new RateLimiter({
        submissionRatePerHour: 50,
      });

      // Other values should use defaults
      expect(customLimiter).toBeDefined();
    });
  });

  describe("Rate Limit Headers", () => {
    it("should provide rate limit information for allowed requests", () => {
      const result = rateLimiter.checkRateLimit("user1", "stream-sync");

      expect(result.allowed).toBe(true);
      expect(result.rateLimit).toBeDefined();
      expect(result.rateLimit?.limit).toBeGreaterThan(0);
      expect(result.rateLimit?.remaining).toBeGreaterThan(0);
      expect(result.rateLimit?.reset).toBeGreaterThan(Date.now() / 1000);
    });

    it("should provide rate limit information for denied requests", () => {
      // Create jobs to exceed limit
      for (let i = 0; i < 100; i++) {
        jobManager.createJob({
          user_id: "user1",
          job_type: "stream-sync",
          priority: "normal",
          payload: { index: i },
        });
      }

      const result = rateLimiter.checkRateLimit("user1", "stream-sync");

      expect(result.allowed).toBe(false);
      expect(result.rateLimit).toBeDefined();
      expect(result.rateLimit?.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });
});
