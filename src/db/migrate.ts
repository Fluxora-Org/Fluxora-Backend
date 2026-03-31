/**
 * Database migration runner
 *
 * Applies migrations in order, tracking which have been applied.
 * Uses SQLite's built-in journaling for atomic commits.
 *
 * @module db/migrate
 */

import Database from "better-sqlite3";
import { info, warn, error as logError } from "../utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import migrations - they will be executed in order by filename
const migrations: { up: string; down: string }[] = [];

async function loadMigrations(): Promise<void> {
  const migrationFiles = await Promise.all([
    import("./migrations/001_create_streams_table.js"),
    import("./migrations/002_create_jobs_tables.js"),
  ]);

  for (const mod of migrationFiles) {
    migrations.push({ up: mod.up, down: mod.down });
  }
}

export interface MigrationResult {
  applied: string[];
  failed: string[];
}

/**
 * Run all pending migrations
 */
export function migrate(
  db: Database.Database,
  direction: "up" | "down" = "up",
): MigrationResult {
  const applied: string[] = [];
  const failed: string[] = [];

  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Get already applied migrations
  const appliedMigrations = db
    .prepare("SELECT name FROM _migrations ORDER BY id")
    .all() as { name: string }[];
  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  const migrationNames = [
    "001_create_streams_table",
    "002_create_jobs_tables",
  ];

  if (direction === "up") {
    // Apply pending migrations
    for (let i = 0; i < migrations.length; i++) {
      const name = migrationNames[i];

      if (appliedNames.has(name)) {
        info(`Migration ${name} already applied, skipping`);
        continue;
      }

      try {
        info(`Applying migration: ${name}`);
        db.exec(migrations[i].up);

        // Record successful migration
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
        applied.push(name);
        info(`Successfully applied: ${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        logError(`Failed to apply migration ${name}: ${message}`);
        failed.push(name);
        break;
      }
    }
  } else {
    // Rollback in reverse order
    for (let i = migrations.length - 1; i >= 0; i--) {
      const name = migrationNames[i];

      if (!appliedNames.has(name)) {
        warn(`Migration ${name} not applied, skipping rollback`);
        continue;
      }

      try {
        info(`Rolling back migration: ${name}`);
        db.exec(migrations[i].down);
        db.prepare("DELETE FROM _migrations WHERE name = ?").run(name);
        applied.push(name);
        info(`Successfully rolled back: ${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        logError(`Failed to rollback migration ${name}: ${message}`);
        failed.push(name);
        break;
      }
    }
  }

  return { applied, failed };
}

/**
 * Get current migration status
 */
export function getMigrationStatus(db: Database.Database): {
  total: number;
  applied: number;
  pending: number;
} {
  const total = migrations.length;

  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedCount = db
    .prepare("SELECT COUNT(*) as count FROM _migrations")
    .get() as { count: number };

  return {
    total,
    applied: appliedCount.count,
    pending: total - appliedCount.count,
  };
}

// Auto-run migrations when module is imported
export async function initializeMigrations(
  db: Database.Database,
): Promise<void> {
  await loadMigrations();

  const status = getMigrationStatus(db);
  info("Migration status", {
    total: status.total,
    applied: status.applied,
    pending: status.pending,
  });

  if (status.pending > 0) {
    const result = migrate(db, "up");
    if (result.failed.length > 0) {
      throw new Error(`Migration failed: ${result.failed.join(", ")}`);
    }
  }
}
