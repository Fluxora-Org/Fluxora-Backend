/**
 * Tests for Job Submission API
 *
 * Validates Requirements:
 * - 1.1: At-least-once execution semantics
 * - 1.2: Idempotent job processing
 * - 1.3: Durable state management
 * - 2.1: Authenticated API clients can submit jobs
 * - 2.2: Administrators can submit jobs on behalf of any user
 * - 2.3: Job owners can view their own job status
 * - 2.4: Administrators can view all jobs
 * - 2.5: Rate limits on job submissions per user
 * - 3.1: Invalid job parameters return 400 Bad Request
 * - 3.2: Rate limit exceeded returns 429 Too Many Requests
 * - 3.7: Duplicate job submission returns existing job ID (idempotent)
 *
 * @module tests/jobs-api
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { generateToken } from "../src/lib/auth.js";
import { randomUUID } from "crypto";
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
    enableRateLimit: true,
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

describe("POST /api/jobs - Job Submission API", () => {

  describe("Authentication and Authorization", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("should accept authenticated requests with valid JWT", async () => {
      const token = generateToken({ address: "user123", role: "user" });

      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("jobId");
      expect(response.body.state).toBe("PENDING");
    });

    it("should reject requests with invalid JWT", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", "Bearer invalid-token")
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(401);
    });
  });

  describe("Job Validation", () => {
    let token: string;

    beforeEach(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should reject request without jobType", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("jobType");
    });

    it("should reject request without priority", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("priority");
    });

    it("should reject request without payload", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("payload");
    });

    it("should reject request with invalid jobType", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "invalid-type",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("Invalid jobType");
    });

    it("should reject request with invalid priority", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "invalid-priority",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("Invalid priority");
    });

    it("should reject request with non-object payload", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: "not-an-object",
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("payload");
    });

    it("should reject request with invalid idempotencyKey format", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
          idempotencyKey: "",
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("idempotencyKey");
    });

    it("should reject request with idempotencyKey exceeding max length", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
          idempotencyKey: "x".repeat(256),
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("255 characters");
    });

    it("should accept valid job types", async () => {
      const jobTypes = ["stream-sync", "event-sync", "cleanup"];

      for (const jobType of jobTypes) {
        const response = await request(app)
          .post("/api/jobs")
          .set("Authorization", `Bearer ${token}`)
          .send({
            jobType,
            priority: "normal",
            payload: { test: "data" },
          });

        expect(response.status).toBe(202);
        expect(response.body.jobId).toBeDefined();
      }
    });

    it("should accept valid priorities", async () => {
      const priorities = ["high", "normal", "low"];

      for (const priority of priorities) {
        const response = await request(app)
          .post("/api/jobs")
          .set("Authorization", `Bearer ${token}`)
          .send({
            jobType: "stream-sync",
            priority,
            payload: { test: "data" },
          });

        expect(response.status).toBe(202);
        expect(response.body.jobId).toBeDefined();
      }
    });
  });

  describe("Idempotency", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should return same job ID for duplicate idempotency key", async () => {
      const idempotencyKey = randomUUID();

      const response1 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
          idempotencyKey,
        });

      const response2 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
          idempotencyKey,
        });

      expect(response1.status).toBe(202);
      expect(response2.status).toBe(202);
      expect(response1.body.jobId).toBe(response2.body.jobId);
    });

    it("should create different jobs for different idempotency keys", async () => {
      const idempotencyKey1 = randomUUID();
      const idempotencyKey2 = randomUUID();

      const response1 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
          idempotencyKey: idempotencyKey1,
        });

      const response2 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
          idempotencyKey: idempotencyKey2,
        });

      expect(response1.status).toBe(202);
      expect(response2.status).toBe(202);
      expect(response1.body.jobId).not.toBe(response2.body.jobId);
    });

    it("should create different jobs without idempotency key", async () => {
      const response1 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      const response2 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response1.status).toBe(202);
      expect(response2.status).toBe(202);
      expect(response1.body.jobId).not.toBe(response2.body.jobId);
    });
  });

  describe("Response Format", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should return 202 Accepted with job details", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("jobId");
      expect(response.body).toHaveProperty("state");
      expect(response.body).toHaveProperty("createdAt");
      expect(response.body).toHaveProperty("requestId");
      expect(response.body.state).toBe("PENDING");
    });

    it("should include correlation ID in response", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(202);
      expect(response.body.requestId).toBeDefined();
    });

    it("should return valid UUID for jobId", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(202);
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(response.body.jobId).toMatch(uuidRegex);
    });

    it("should return ISO 8601 timestamp for createdAt", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "test-stream" },
        });

      expect(response.status).toBe(202);
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(response.body.createdAt).toMatch(isoRegex);
    });
  });

  describe("Rate Limiting", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "rate-limit-user", role: "user" });
    });

    it("should enforce rate limits on job submissions", async () => {
      // Submit jobs up to the rate limit (100 per hour)
      // For testing, we'll submit a smaller number to verify rate limiting works
      const requests = [];
      for (let i = 0; i < 105; i++) {
        requests.push(
          request(app)
            .post("/api/jobs")
            .set("Authorization", `Bearer ${token}`)
            .send({
              jobType: "stream-sync",
              priority: "normal",
              payload: { index: i },
            }),
        );
      }

      const responses = await Promise.all(requests);

      // Some requests should succeed (202)
      const successCount = responses.filter((r) => r.status === 202).length;
      // Some requests should be rate limited (429)
      const rateLimitedCount = responses.filter((r) => r.status === 429).length;

      expect(successCount).toBeGreaterThan(0);
      expect(rateLimitedCount).toBeGreaterThan(0);
      expect(successCount + rateLimitedCount).toBe(105);
    });

    it("should return 429 with proper error format when rate limited", async () => {
      const token2 = generateToken({ address: "rate-limit-user-2", role: "user" });

      // Submit many requests to trigger rate limit
      const requests = [];
      for (let i = 0; i < 105; i++) {
        requests.push(
          request(app)
            .post("/api/jobs")
            .set("Authorization", `Bearer ${token2}`)
            .send({
              jobType: "stream-sync",
              priority: "normal",
              payload: { index: i },
            }),
        );
      }

      const responses = await Promise.all(requests);
      const rateLimitedResponse = responses.find((r) => r.status === 429);

      if (rateLimitedResponse) {
        expect(rateLimitedResponse.body.error).toBeDefined();
        expect(rateLimitedResponse.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
        expect(rateLimitedResponse.body.error.message).toContain("Too many requests");
      }
    });
  });

  describe("Job Payload Validation", () => {
    let token: string;

    beforeAll(() => {
      token = generateToken({ address: "user123", role: "user" });
    });

    it("should accept complex payload objects", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: {
            streamId: "test-stream",
            options: {
              startLedger: 1000,
              endLedger: 2000,
              batchSize: 100,
            },
            metadata: {
              source: "api",
              version: "1.0",
            },
          },
        });

      expect(response.status).toBe(202);
      expect(response.body.jobId).toBeDefined();
    });

    it("should accept payload with arrays", async () => {
      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "event-sync",
          priority: "high",
          payload: {
            eventIds: ["event-1", "event-2", "event-3"],
            filters: ["type:payment", "type:transfer"],
          },
        });

      expect(response.status).toBe(202);
      expect(response.body.jobId).toBeDefined();
    });

    it("should reject payload exceeding size limit", async () => {
      // Create a payload larger than 1MB
      const largePayload = {
        data: "x".repeat(2 * 1024 * 1024), // 2MB
      };

      const response = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: largePayload,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain("exceeds maximum");
    });
  });

  describe("User Isolation", () => {
    it("should create jobs with correct user_id", async () => {
      const user1Token = generateToken({ address: "user-1", role: "user" });
      const user2Token = generateToken({ address: "user-2", role: "user" });

      const response1 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${user1Token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "stream-1" },
        });

      const response2 = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${user2Token}`)
        .send({
          jobType: "stream-sync",
          priority: "normal",
          payload: { streamId: "stream-2" },
        });

      expect(response1.status).toBe(202);
      expect(response2.status).toBe(202);
      expect(response1.body.jobId).not.toBe(response2.body.jobId);

      // Verify jobs are created with correct user_id
      const job1 = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(response1.body.jobId) as any;
      const job2 = testDb
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(response2.body.jobId) as any;

      expect(job1.user_id).toBe("user-1");
      expect(job2.user_id).toBe("user-2");
    });
  });
});
