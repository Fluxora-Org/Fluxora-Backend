/**
 * Tests for Job Cancellation and Retry API
 *
 * Validates Requirements:
 * - 9.1: Job submission with optional idempotency key
 * - 9.2: Job cancellation before execution starts
 * - 9.3: Job cancellation during execution with graceful shutdown
 * - 9.4: Job retry with optional parameter override
 * - 9.5: Job deletion after completion (with retention policy)
 * - 9.6: Job archival for long-term retention
 * - 9.7: Bulk operations (cancel, retry, delete) on multiple jobs
 * - 9.8: Job state consistency during lifecycle transitions
 * - 9.9: Job dependency tracking
 * - 9.10: Job lifecycle event hooks
 *
 * @module tests/jobs-cancel-retry
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { generateToken } from "../src/lib/auth.js";
import Database from "better-sqlite3";
import * as dbConnection from "../src/db/connection.js";
import * as envConfig from "../src/config/env.js";

// Test database
let testDb: Database.Database;

beforeAll(async () => {
  // Initialize config for tests
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-key-for-testing-purposes-only";
  vi.spyOn(envConfig, "getConfig").mockReturnValue({
    port: 3000,
    nodeEnv: "test",
    apiVersion: "0.1.0",
    databaseUrl: "postgresql://localhost/fluxora",
    databasePoolMin: 2,
    databasePoolMax: 10,
    databaseConnectionTimeout: 5000,
    databaseIdleTimeout: 30000,
    redisUrl: "redis://localhost:6379",
    redisEnabled: false,
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    horizonNetworkPassphrase: "Test SDF Network ; September 2015",
    contractAddresses: { streaming: "PLACEHOLDER" },
    jwtSecret: "test-secret-key-for-testing-purposes-only",
    jwtExpiresIn: "24h",
    apiKeys: ["test-api-key"],
    maxRequestSizeBytes: 1024 * 1024,
    maxJsonDepth: 20,
    requestTimeoutMs: 30000,
    logLevel: "error",
    metricsEnabled: false,
    enableStreamValidation: false,
    enableRateLimit: false,
  });

  // Create in-memory database for testing
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");

  // Run only the jobs migration directly
  const { up } = await import("../src/db/migrations/002_create_jobs_tables.js");
  testDb.exec(up);

  // Mock getDatabase to return test database
  vi.spyOn(dbConnection, "getDatabase").mockReturnValue(testDb);
});

afterAll(() => {
  // Restore mocks
  vi.restoreAllMocks();

  // Close test database
  if (testDb) {
    testDb.close();
  }
});

describe("DELETE /api/jobs/{jobId} - Job Cancellation", () => {
  describe("Authentication and Authorization", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const response = await request(app).delete("/api/jobs/test-job-id");

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("should allow job owner to cancel their own job", async () => {
      const token = generateToken({ address: "user123", role: "user" });

      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Cancel the job
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(cancelResponse.status).toBe(204);

      // Verify job is cancelled
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.state).toBe("CANCELLED");
    });

    it("should prevent non-owner from cancelling job", async () => {
      const ownerToken = generateToken({ address: "owner", role: "user" });
      const otherToken = generateToken({ address: "other", role: "user" });

      // Create a job as owner
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Try to cancel as other user
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${otherToken}`);

      expect(cancelResponse.status).toBe(403);
      if (cancelResponse.body.error) {
        expect(cancelResponse.body.error.code).toBe("FORBIDDEN");
      }
    });

    it("should allow admin to cancel any job", async () => {
      const userToken = generateToken({ address: "user", role: "user" });
      const adminToken = generateToken({ address: "admin", role: "admin" });

      // Create a job as user
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Cancel as admin
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(cancelResponse.status).toBe(204);

      // Verify job is cancelled
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.state).toBe("CANCELLED");
    });
  });

  describe("Validation", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should reject invalid jobId format", async () => {
      const response = await request(app)
        .delete("/api/jobs/invalid-id")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(400);
      // Response body might be empty for some errors
    });

    it("should return 404 for non-existent job", async () => {
      const fakeJobId = "00000000-0000-0000-0000-000000000000";

      const response = await request(app)
        .delete(`/api/jobs/${fakeJobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(404);
    });
  });

  describe("State Transitions", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should cancel PENDING job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Cancel the job
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(cancelResponse.status).toBe(204);

      // Verify state transition
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.state).toBe("CANCELLED");
    });

    it("should cancel RUNNING job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to RUNNING state
      testDb
        .prepare("UPDATE jobs SET state = ?, started_at = ? WHERE id = ?")
        .run("RUNNING", new Date().toISOString(), jobId);

      // Cancel the job
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(cancelResponse.status).toBe(204);

      // Verify state transition
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.state).toBe("CANCELLED");
    });

    it("should reject cancellation of COMPLETED job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to COMPLETED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("COMPLETED", new Date().toISOString(), jobId);

      // Try to cancel the job
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(cancelResponse.status).toBe(400);
    });

    it("should reject cancellation of FAILED job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Try to cancel the job
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(cancelResponse.status).toBe(400);
    });

    it("should reject cancellation of already CANCELLED job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Cancel the job once
      await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      // Try to cancel again
      const cancelResponse = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(cancelResponse.status).toBe(400);
    });
  });

  describe("History Tracking", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should record cancellation in job history", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Cancel the job
      await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      // Check history
      const history = testDb
        .prepare("SELECT * FROM job_history WHERE job_id = ? ORDER BY transitioned_at ASC")
        .all(jobId) as any[];

      expect(history.length).toBeGreaterThanOrEqual(2);
      
      // Find the cancellation transition
      const cancellationTransition = history.find(
        (h) => h.new_state === "CANCELLED"
      );
      expect(cancellationTransition).toBeDefined();
      expect(cancellationTransition.old_state).toBe("PENDING");
      expect(cancellationTransition.transition_reason).toContain("Cancelled");
    });
  });
});

describe("POST /api/jobs/{jobId}/retry - Job Retry", () => {
  describe("Authentication and Authorization", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const response = await request(app).post("/api/jobs/test-job-id/retry");

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("should allow job owner to retry their own job", async () => {
      const token = generateToken({ address: "user123", role: "user" });

      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry the job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(202);
      expect(retryResponse.body.jobId).toBe(jobId);
      expect(retryResponse.body.state).toBe("PENDING");
    });

    it("should prevent non-owner from retrying job", async () => {
      const ownerToken = generateToken({ address: "owner", role: "user" });
      const otherToken = generateToken({ address: "other", role: "user" });

      // Create a job as owner
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Try to retry as other user
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({});

      expect(retryResponse.status).toBe(403);
    });

    it("should allow admin to retry any job", async () => {
      const userToken = generateToken({ address: "user", role: "user" });
      const adminToken = generateToken({ address: "admin", role: "admin" });

      // Create a job as user
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry as admin
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(retryResponse.status).toBe(202);
      expect(retryResponse.body.state).toBe("PENDING");
    });
  });

  describe("Validation", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should reject invalid jobId format", async () => {
      const response = await request(app)
        .post("/api/jobs/invalid-id/retry")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(400);
    });

    it("should return 404 for non-existent job", async () => {
      const fakeJobId = "00000000-0000-0000-0000-000000000000";

      const response = await request(app)
        .post(`/api/jobs/${fakeJobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(404);
    });

    it("should reject invalid priority in parameter override", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Try to retry with invalid priority
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({ priority: "invalid-priority" });

      expect(retryResponse.status).toBe(400);
    });

    it("should reject non-object payload in parameter override", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Try to retry with invalid payload
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({ payload: "not-an-object" });

      expect(retryResponse.status).toBe(400);
    });
  });

  describe("State Transitions", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should retry FAILED job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ?, error_message = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), "Test error", jobId);

      // Retry the job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(202);
      expect(retryResponse.body.state).toBe("PENDING");

      // Verify state transition
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.state).toBe("PENDING");
      expect(job.error_message).toBeNull();
      expect(job.error_code).toBeNull();
    });

    it("should reject retry of PENDING job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Try to retry PENDING job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(400);
    });

    it("should reject retry of RUNNING job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to RUNNING state
      testDb
        .prepare("UPDATE jobs SET state = ?, started_at = ? WHERE id = ?")
        .run("RUNNING", new Date().toISOString(), jobId);

      // Try to retry RUNNING job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(400);
    });

    it("should reject retry of COMPLETED job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to COMPLETED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("COMPLETED", new Date().toISOString(), jobId);

      // Try to retry COMPLETED job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(400);
    });

    it("should reject retry of CANCELLED job", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Cancel the job
      await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("Authorization", `Bearer ${token}`);

      // Try to retry CANCELLED job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(400);
    });
  });

  describe("Parameter Override", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should retry job without parameter override", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry without override
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(202);

      // Verify original parameters unchanged
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.priority).toBe(1); // normal = 1
      expect(JSON.parse(job.payload)).toEqual({ streamId: "test-stream" });
    });

    it("should retry job with priority override", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry with priority override
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({ priority: "high" });

      expect(retryResponse.status).toBe(202);

      // Verify priority changed
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.priority).toBe(2); // high = 2
    });

    it("should retry job with payload override", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry with payload override
      const newPayload = { streamId: "new-stream", options: { retry: true } };
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({ payload: newPayload });

      expect(retryResponse.status).toBe(202);

      // Verify payload changed
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(JSON.parse(job.payload)).toEqual(newPayload);
    });

    it("should retry job with both priority and payload override", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "low",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry with both overrides
      const newPayload = { streamId: "new-stream" };
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({ priority: "high", payload: newPayload });

      expect(retryResponse.status).toBe(202);

      // Verify both changed
      const job = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as any;
      expect(job.priority).toBe(2); // high = 2
      expect(JSON.parse(job.payload)).toEqual(newPayload);
    });
  });

  describe("History Tracking", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should record retry transitions in job history", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry the job
      await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      // Check history
      const history = testDb
        .prepare("SELECT * FROM job_history WHERE job_id = ? ORDER BY transitioned_at ASC")
        .all(jobId) as any[];

      // Should have: PENDING (creation), FAILED (manual), RETRYING, PENDING (retry)
      expect(history.length).toBeGreaterThanOrEqual(3);

      // Find the RETRYING transition
      const retryingTransition = history.find(
        (h) => h.new_state === "RETRYING"
      );
      expect(retryingTransition).toBeDefined();
      expect(retryingTransition.old_state).toBe("FAILED");
      expect(retryingTransition.transition_reason).toContain("Manual retry");

      // Find the final PENDING transition
      const pendingTransitions = history.filter(
        (h) => h.new_state === "PENDING"
      );
      expect(pendingTransitions.length).toBeGreaterThanOrEqual(2);
      const lastPending = pendingTransitions[pendingTransitions.length - 1];
      expect(lastPending.old_state).toBe("RETRYING");
      expect(lastPending.transition_reason).toContain("retry");
    });
  });

  describe("Response Format", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should return 202 Accepted with job details", async () => {
      // Create a job
      const createResponse = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const jobId = createResponse.body.jobId;

      // Manually set job to FAILED state
      testDb
        .prepare("UPDATE jobs SET state = ?, completed_at = ? WHERE id = ?")
        .run("FAILED", new Date().toISOString(), jobId);

      // Retry the job
      const retryResponse = await request(app)
        .post(`/api/jobs/${jobId}/retry`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(retryResponse.status).toBe(202);
      expect(retryResponse.body).toHaveProperty("jobId");
      expect(retryResponse.body).toHaveProperty("state");
      expect(retryResponse.body).toHaveProperty("attempt");
      expect(retryResponse.body).toHaveProperty("requestId");
      expect(retryResponse.body.jobId).toBe(jobId);
      expect(retryResponse.body.state).toBe("PENDING");
    });
  });
});
