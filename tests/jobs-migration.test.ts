/**
 * Tests for job queue database migration
 *
 * Validates that the migration creates the correct schema and indexes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { up, down } from "../src/db/migrations/002_create_jobs_tables.js";

describe("Jobs Migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("up migration", () => {
    it("should create jobs table", () => {
      db.exec(up);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .all();

      expect(tables).toHaveLength(1);
      expect(tables[0]).toEqual({ name: "jobs" });
    });

    it("should create job_history table", () => {
      db.exec(up);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='job_history'",
        )
        .all();

      expect(tables).toHaveLength(1);
      expect(tables[0]).toEqual({ name: "job_history" });
    });

    it("should create indexes on jobs table", () => {
      db.exec(up);

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'",
        )
        .all() as { name: string }[];

      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain("idx_jobs_state");
      expect(indexNames).toContain("idx_jobs_priority");
      expect(indexNames).toContain("idx_jobs_user_id");
      expect(indexNames).toContain("idx_jobs_created_at");
      expect(indexNames).toContain("idx_jobs_scheduled_for");
      expect(indexNames).toContain("idx_jobs_correlation_id");
      expect(indexNames).toContain("idx_jobs_job_type");
    });

    it("should create indexes on job_history table", () => {
      db.exec(up);

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_history'",
        )
        .all() as { name: string }[];

      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain("idx_job_history_job_id");
      expect(indexNames).toContain("idx_job_history_transitioned_at");
    });

    it("should enforce job_type check constraint", () => {
      db.exec(up);

      // Valid job type should succeed
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, payload) 
           VALUES ('job-1', 'user-1', 'stream-sync', '{}')`,
        ).run();
      }).not.toThrow();

      // Invalid job type should fail
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, payload) 
           VALUES ('job-2', 'user-1', 'invalid-type', '{}')`,
        ).run();
      }).toThrow();
    });

    it("should enforce state check constraint", () => {
      db.exec(up);

      // Valid state should succeed
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, state, payload) 
           VALUES ('job-1', 'user-1', 'stream-sync', 'PENDING', '{}')`,
        ).run();
      }).not.toThrow();

      // Invalid state should fail
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, state, payload) 
           VALUES ('job-2', 'user-1', 'stream-sync', 'INVALID', '{}')`,
        ).run();
      }).toThrow();
    });

    it("should enforce priority check constraint (0-2)", () => {
      db.exec(up);

      // Valid priorities should succeed
      for (const priority of [0, 1, 2]) {
        expect(() => {
          db.prepare(
            `INSERT INTO jobs (id, user_id, job_type, priority, payload) 
             VALUES (?, 'user-1', 'stream-sync', ?, '{}')`,
          ).run(`job-${priority}`, priority);
        }).not.toThrow();
      }

      // Invalid priority should fail
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, priority, payload) 
           VALUES ('job-invalid', 'user-1', 'stream-sync', 3, '{}')`,
        ).run();
      }).toThrow();
    });

    it("should enforce progress_percent check constraint (0-100)", () => {
      db.exec(up);

      // Valid progress should succeed
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, payload, progress_percent) 
           VALUES ('job-1', 'user-1', 'stream-sync', '{}', 50)`,
        ).run();
      }).not.toThrow();

      // Invalid progress (> 100) should fail
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, payload, progress_percent) 
           VALUES ('job-2', 'user-1', 'stream-sync', '{}', 101)`,
        ).run();
      }).toThrow();

      // Invalid progress (< 0) should fail
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, payload, progress_percent) 
           VALUES ('job-3', 'user-1', 'stream-sync', '{}', -1)`,
        ).run();
      }).toThrow();
    });

    it("should enforce unique idempotency_key constraint", () => {
      db.exec(up);

      // First insert should succeed
      db.prepare(
        `INSERT INTO jobs (id, user_id, job_type, payload, idempotency_key) 
         VALUES ('job-1', 'user-1', 'stream-sync', '{}', 'key-123')`,
      ).run();

      // Duplicate idempotency_key should fail
      expect(() => {
        db.prepare(
          `INSERT INTO jobs (id, user_id, job_type, payload, idempotency_key) 
           VALUES ('job-2', 'user-1', 'stream-sync', '{}', 'key-123')`,
        ).run();
      }).toThrow();
    });

    it("should set default values correctly", () => {
      db.exec(up);

      db.prepare(
        `INSERT INTO jobs (id, user_id, job_type, payload) 
         VALUES ('job-1', 'user-1', 'stream-sync', '{}')`,
      ).run();

      const job = db
        .prepare("SELECT * FROM jobs WHERE id = 'job-1'")
        .get() as any;

      expect(job.state).toBe("PENDING");
      expect(job.priority).toBe(1); // normal
      expect(job.attempt).toBe(0);
      expect(job.max_attempts).toBe(3);
      expect(job.progress_percent).toBe(0);
      expect(job.created_at).toBeDefined();
    });

    it("should enforce foreign key constraint on job_history", () => {
      db.exec(up);

      // Enable foreign key constraints
      db.pragma("foreign_keys = ON");

      // Create a job first
      db.prepare(
        `INSERT INTO jobs (id, user_id, job_type, payload) 
         VALUES ('job-1', 'user-1', 'stream-sync', '{}')`,
      ).run();

      // Valid foreign key should succeed
      expect(() => {
        db.prepare(
          `INSERT INTO job_history (id, job_id, new_state) 
           VALUES ('history-1', 'job-1', 'RUNNING')`,
        ).run();
      }).not.toThrow();

      // Invalid foreign key should fail
      expect(() => {
        db.prepare(
          `INSERT INTO job_history (id, job_id, new_state) 
           VALUES ('history-2', 'nonexistent-job', 'RUNNING')`,
        ).run();
      }).toThrow();
    });

    it("should cascade delete job_history when job is deleted", () => {
      db.exec(up);
      db.pragma("foreign_keys = ON");

      // Create job and history
      db.prepare(
        `INSERT INTO jobs (id, user_id, job_type, payload) 
         VALUES ('job-1', 'user-1', 'stream-sync', '{}')`,
      ).run();

      db.prepare(
        `INSERT INTO job_history (id, job_id, new_state) 
         VALUES ('history-1', 'job-1', 'RUNNING')`,
      ).run();

      // Delete job
      db.prepare("DELETE FROM jobs WHERE id = 'job-1'").run();

      // History should be deleted
      const history = db
        .prepare("SELECT * FROM job_history WHERE id = 'history-1'")
        .all();

      expect(history).toHaveLength(0);
    });
  });

  describe("down migration", () => {
    it("should drop job_history table", () => {
      db.exec(up);
      db.exec(down);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='job_history'",
        )
        .all();

      expect(tables).toHaveLength(0);
    });

    it("should drop jobs table", () => {
      db.exec(up);
      db.exec(down);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .all();

      expect(tables).toHaveLength(0);
    });

    it("should be idempotent (can run multiple times)", () => {
      db.exec(up);

      expect(() => {
        db.exec(down);
        db.exec(down);
      }).not.toThrow();
    });
  });

  describe("migration roundtrip", () => {
    it("should be able to apply and rollback migration", () => {
      // Apply migration
      db.exec(up);

      // Insert test data
      db.prepare(
        `INSERT INTO jobs (id, user_id, job_type, payload) 
         VALUES ('job-1', 'user-1', 'stream-sync', '{}')`,
      ).run();

      // Rollback migration
      db.exec(down);

      // Tables should be gone
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('jobs', 'job_history')",
        )
        .all();

      expect(tables).toHaveLength(0);
    });

    it("should be able to reapply migration after rollback", () => {
      // Apply, rollback, reapply
      db.exec(up);
      db.exec(down);
      db.exec(up);

      // Tables should exist
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('jobs', 'job_history')",
        )
        .all();

      expect(tables).toHaveLength(2);
    });
  });
});
