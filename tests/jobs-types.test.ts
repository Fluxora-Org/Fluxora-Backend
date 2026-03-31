/**
 * Tests for job queue types and constants
 *
 * Validates type definitions, state transitions, and configuration defaults
 */

import { describe, it, expect } from "vitest";
import {
  JOB_STATE_TRANSITIONS,
  PRIORITY_VALUES,
  VALUE_TO_PRIORITY,
  DEFAULT_JOB_CONFIGS,
  JOB_INVARIANTS,
  type JobState,
  type JobPriority,
  type JobType,
} from "../src/jobs/types.js";

describe("Job State Transitions", () => {
  it("should define valid transitions for PENDING state", () => {
    expect(JOB_STATE_TRANSITIONS.PENDING).toEqual(["RUNNING", "CANCELLED"]);
  });

  it("should define valid transitions for RUNNING state", () => {
    expect(JOB_STATE_TRANSITIONS.RUNNING).toEqual([
      "COMPLETED",
      "FAILED",
      "RETRYING",
      "CANCELLED",
    ]);
  });

  it("should define valid transitions for COMPLETED state", () => {
    expect(JOB_STATE_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("should define valid transitions for FAILED state", () => {
    expect(JOB_STATE_TRANSITIONS.FAILED).toEqual(["RETRYING"]);
  });

  it("should define valid transitions for RETRYING state", () => {
    expect(JOB_STATE_TRANSITIONS.RETRYING).toEqual(["PENDING"]);
  });

  it("should define valid transitions for CANCELLED state", () => {
    expect(JOB_STATE_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("should have transitions defined for all job states", () => {
    const states: JobState[] = [
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "RETRYING",
      "CANCELLED",
    ];

    for (const state of states) {
      expect(JOB_STATE_TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(JOB_STATE_TRANSITIONS[state])).toBe(true);
    }
  });
});

describe("Priority Mappings", () => {
  it("should map priority names to numeric values", () => {
    expect(PRIORITY_VALUES.low).toBe(0);
    expect(PRIORITY_VALUES.normal).toBe(1);
    expect(PRIORITY_VALUES.high).toBe(2);
  });

  it("should map numeric values to priority names", () => {
    expect(VALUE_TO_PRIORITY[0]).toBe("low");
    expect(VALUE_TO_PRIORITY[1]).toBe("normal");
    expect(VALUE_TO_PRIORITY[2]).toBe("high");
  });

  it("should have bidirectional mapping consistency", () => {
    const priorities: JobPriority[] = ["low", "normal", "high"];

    for (const priority of priorities) {
      const value = PRIORITY_VALUES[priority];
      expect(VALUE_TO_PRIORITY[value]).toBe(priority);
    }
  });
});

describe("Default Job Configurations", () => {
  it("should define configuration for stream-sync job type", () => {
    const config = DEFAULT_JOB_CONFIGS["stream-sync"];

    expect(config.name).toBe("stream-sync");
    expect(config.timeout).toBe(300000); // 5 minutes
    expect(config.maxRetries).toBe(3);
    expect(config.initialBackoff).toBe(1000);
    expect(config.maxBackoff).toBe(60000);
    expect(config.priority).toBe("normal");
    expect(config.rateLimit).toBeDefined();
    expect(config.rateLimit?.perUser).toBe(100);
    expect(config.rateLimit?.concurrent).toBe(10);
  });

  it("should define configuration for event-sync job type", () => {
    const config = DEFAULT_JOB_CONFIGS["event-sync"];

    expect(config.name).toBe("event-sync");
    expect(config.timeout).toBe(600000); // 10 minutes
    expect(config.maxRetries).toBe(5);
    expect(config.initialBackoff).toBe(2000);
    expect(config.maxBackoff).toBe(120000);
    expect(config.priority).toBe("high");
    expect(config.rateLimit).toBeDefined();
    expect(config.rateLimit?.perUser).toBe(50);
    expect(config.rateLimit?.concurrent).toBe(5);
  });

  it("should define configuration for cleanup job type", () => {
    const config = DEFAULT_JOB_CONFIGS["cleanup"];

    expect(config.name).toBe("cleanup");
    expect(config.timeout).toBe(180000); // 3 minutes
    expect(config.maxRetries).toBe(2);
    expect(config.initialBackoff).toBe(5000);
    expect(config.maxBackoff).toBe(300000);
    expect(config.priority).toBe("low");
    expect(config.rateLimit).toBeDefined();
    expect(config.rateLimit?.perUser).toBe(20);
    expect(config.rateLimit?.concurrent).toBe(2);
  });

  it("should have configurations for all job types", () => {
    const jobTypes: JobType[] = ["stream-sync", "event-sync", "cleanup"];

    for (const jobType of jobTypes) {
      expect(DEFAULT_JOB_CONFIGS[jobType]).toBeDefined();
      expect(DEFAULT_JOB_CONFIGS[jobType].name).toBe(jobType);
    }
  });

  it("should have valid timeout values (positive)", () => {
    const jobTypes: JobType[] = ["stream-sync", "event-sync", "cleanup"];

    for (const jobType of jobTypes) {
      const config = DEFAULT_JOB_CONFIGS[jobType];
      expect(config.timeout).toBeGreaterThan(0);
    }
  });

  it("should have valid backoff values (initial < max)", () => {
    const jobTypes: JobType[] = ["stream-sync", "event-sync", "cleanup"];

    for (const jobType of jobTypes) {
      const config = DEFAULT_JOB_CONFIGS[jobType];
      expect(config.initialBackoff).toBeGreaterThan(0);
      expect(config.maxBackoff).toBeGreaterThan(config.initialBackoff);
    }
  });
});

describe("Job Invariants", () => {
  it("should define priority constraints", () => {
    expect(JOB_INVARIANTS.priorityConstraints.min).toBe(0);
    expect(JOB_INVARIANTS.priorityConstraints.max).toBe(2);
  });

  it("should define attempt constraints", () => {
    expect(JOB_INVARIANTS.attemptConstraints.min).toBe(0);
    expect(JOB_INVARIANTS.attemptConstraints.max).toBe(10);
  });

  it("should define progress constraints", () => {
    expect(JOB_INVARIANTS.progressConstraints.min).toBe(0);
    expect(JOB_INVARIANTS.progressConstraints.max).toBe(100);
  });

  it("should define max payload size (1MB)", () => {
    expect(JOB_INVARIANTS.maxPayloadSize).toBe(1024 * 1024);
  });

  it("should define idempotency key TTL (24 hours)", () => {
    expect(JOB_INVARIANTS.idempotencyKeyTTL).toBe(24 * 60 * 60 * 1000);
  });

  it("should reference valid state transitions", () => {
    expect(JOB_INVARIANTS.validTransitions).toBe(JOB_STATE_TRANSITIONS);
  });
});
