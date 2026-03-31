/**
 * Tests for Job Query API (GET endpoints)
 *
 * Validates Requirements 8.1-8.10, 2.3, 2.4, 2.7
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { generateToken } from "../src/lib/auth.js";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import * as dbConnection from "../src/db/connection.js";
import * as envConfig from "../src/config/env.js";
import { JobManager } from "../src/jobs/JobManager.js";

let testDb;
let jobManager;

beforeAll(async () => {
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

  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  const { up } = await import("../src/db/migrations/002_create_jobs_tables.js");
  testDb.exec(up);
  vi.spyOn(dbConnection, "getDatabase").mockReturnValue(testDb);
  jobManager = new JobManager();
});

afterAll(() => {
  vi.restoreAllMocks();
  if (testDb) testDb.close();
});

beforeEach(() => {
  testDb.prepare("DELETE FROM job_history").run();
  testDb.prepare("DELETE FROM jobs").run();
});

describe("GET /api/jobs/:jobId", () => {
  it("should reject unauthenticated requests", async () => {
    const response = await request(app).get(`/api/jobs/${randomUUID()}`);
    expect(response.status).toBe(401);
  });

  it("should allow job owner to view their own job", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobId).toBe(job.id);
  });

  it("should prevent users from viewing other users' jobs", async () => {
    const user1Token = generateToken({ address: "user1", role: "user" });
    const user2Token = generateToken({ address: "user2", role: "user" });
    const job = jobManager.createJob({
      user_id: "user1",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${user2Token}`);

    expect(response.status).toBe(403);
  });

  it("should allow admins to view any job", async () => {
    const adminToken = generateToken({ address: "admin", role: "admin" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
  });

  it("should return 400 for invalid UUID", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const response = await request(app)
      .get("/api/jobs/invalid-uuid")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(400);
  });

  it("should return 404 for non-existent job", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const response = await request(app)
      .get(`/api/jobs/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
  });

  it("should return complete job details", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "high",
      payload: { streamId: "test-stream" },
    });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      jobId: job.id,
      userId: "user123",
      jobType: "stream-sync",
      priority: "high",
      state: "PENDING",
    });
    expect(response.body.history).toBeDefined();
  });

  it("should return job execution history", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    jobManager.updateJobState(job.id, { state: "RUNNING" });
    jobManager.updateJobState(job.id, { state: "COMPLETED", result: { processed: 100 } });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.history).toHaveLength(3);
  });

  it("should return error details for failed jobs", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    // Must go through RUNNING before FAILED
    jobManager.updateJobState(job.id, { state: "RUNNING" });
    jobManager.updateJobState(job.id, {
      state: "FAILED",
      error_message: "Database timeout",
      error_code: "DB_TIMEOUT",
    });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("FAILED");
    expect(response.body.error).toMatchObject({
      message: "Database timeout",
      code: "DB_TIMEOUT",
    });
  });

  it("should return result for completed jobs", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    jobManager.updateJobState(job.id, { state: "RUNNING" });
    jobManager.updateJobState(job.id, {
      state: "COMPLETED",
      result: { processed: 150 },
    });

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ processed: 150 });
  });

  it("should return retry information", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    jobManager.updateJobState(job.id, { state: "RUNNING" });
    jobManager.updateJobState(job.id, {
      state: "RETRYING",
      error_message: "Network error",
      error_code: "NETWORK_ERROR",
    });
    jobManager.incrementAttempt(job.id);

    const response = await request(app)
      .get(`/api/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.state).toBe("RETRYING");
    expect(response.body.attempt).toBe(1);
  });
});

describe("GET /api/jobs", () => {
  it("should reject unauthenticated requests", async () => {
    const response = await request(app).get("/api/jobs");
    expect(response.status).toBe(401);
  });

  it("should return only user's own jobs", async () => {
    const user1Token = generateToken({ address: "user1", role: "user" });
    jobManager.createJob({
      user_id: "user1",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "stream-1" },
    });
    jobManager.createJob({
      user_id: "user2",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "stream-2" },
    });

    const response = await request(app)
      .get("/api/jobs")
      .set("Authorization", `Bearer ${user1Token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].userId).toBe("user1");
  });

  it("should return all jobs for admins", async () => {
    const adminToken = generateToken({ address: "admin", role: "admin" });
    jobManager.createJob({
      user_id: "user1",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "stream-1" },
    });
    jobManager.createJob({
      user_id: "user2",
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "stream-2" },
    });

    const response = await request(app)
      .get("/api/jobs")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(2);
  });

  it("should support pagination", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    for (let i = 0; i < 25; i++) {
      jobManager.createJob({
        user_id: "user123",
        job_type: "stream-sync",
        priority: "normal",
        payload: { index: i },
      });
    }

    const response = await request(app)
      .get("/api/jobs?limit=10&offset=0")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(10);
    expect(response.body.total).toBe(25);
    expect(response.body.hasMore).toBe(true);
  });

  it("should filter by jobType", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    });
    jobManager.createJob({
      user_id: "user123",
      job_type: "event-sync",
      priority: "normal",
      payload: {},
    });

    const response = await request(app)
      .get("/api/jobs?jobType=stream-sync")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].jobType).toBe("stream-sync");
  });

  it("should filter by state", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    const job1 = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    });
    const job2 = jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    });
    jobManager.updateJobState(job2.id, { state: "RUNNING" });

    const response = await request(app)
      .get("/api/jobs?state=RUNNING")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].state).toBe("RUNNING");
  });

  it("should filter by priority", async () => {
    const token = generateToken({ address: "user123", role: "user" });
    jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "high",
      payload: {},
    });
    jobManager.createJob({
      user_id: "user123",
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    });

    const response = await request(app)
      .get("/api/jobs?priority=high")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].priority).toBe("high");
  });
});
