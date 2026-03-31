/**
 * Database connection management
 *
 * Provides a singleton database connection with proper initialization,
 * health checks, and graceful shutdown.
 *
 * @module db/connection
 */

import Database from "better-sqlite3";
import { info, warn, error as logError } from "../utils/logger.js";
import { initializeMigrations } from "./migrate.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database configuration
const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "../../data/fluxora.db");
const DB_MODE = process.env.DB_MODE || "readonly";

let db: Database.Database | null = null;

/**
 * Initialize the database connection and run migrations
 */
export function initDatabase(): Database.Database {
  if (db) {
    warn("Database already initialized");
    return db;
  }

  info("Initializing database", { path: DB_PATH, mode: DB_MODE });

  try {
    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Open database connection
    db = new Database(DB_PATH);

    // Configure SQLite for reliability
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    // Run migrations
    initializeMigrations(db);

    info("Database initialized successfully");
    return db;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("Failed to initialize database", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

/**
 * Check database health
 */
export function checkDatabaseHealth(): {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
} {
  if (!db) {
    return { healthy: false, error: "Database not initialized" };
  }

  try {
    const start = Date.now();
    db.prepare("SELECT 1").get();
    const latencyMs = Date.now() - start;

    return { healthy: true, latencyMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { healthy: false, error: message };
  }
}

/**
 * Close database connection gracefully
 */
export function closeDatabase(): void {
  if (db) {
    info("Closing database connection");
    db.close();
    db = null;
    info("Database connection closed");
  }
}

// Handle process termination
process.on("SIGTERM", () => {
  closeDatabase();
});

process.on("SIGINT", () => {
  closeDatabase();
});
