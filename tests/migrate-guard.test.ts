/**
 * Tests for checkPendingMigrations (src/db/migrate.ts)
 *
 * Covers:
 *  - Missing DATABASE_URL → throws immediately
 *  - All migrations applied → resolves
 *  - No migration files on disk → resolves (short-circuit, no DB call)
 *  - Migrations directory absent → resolves (short-circuit, no DB call)
 *  - One or more unapplied migrations → throws PendingMigrationsError
 *  - PendingMigrationsError carries the pending names list
 *  - pgmigrations table absent + files on disk → throws PendingMigrationsError
 *  - DB connection error → propagates
 *
 * All fs and pg calls are mocked — no real database or filesystem access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── fs mock ───────────────────────────────────────────────────────────────────
// vi.mock is hoisted by vitest so it runs before any imports below.

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const existsSync = vi.fn()
  const readdirSync = vi.fn()
  // Patch both named exports and the default export object so that
  // `import fs from 'fs'` and `import { existsSync } from 'fs'` both see mocks.
  const patched = { ...actual, existsSync, readdirSync }
  patched.default = { ...actual.default, existsSync, readdirSync }
  return patched
})

// ── pg mock ───────────────────────────────────────────────────────────────────
// Shared mock handles — the same object is returned by every `new pg.Client()`.

const pgClientMocks = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
}

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>()
  // Must be a regular function (not arrow) so it can be called with `new`.
  function MockClient() {
    return pgClientMocks
  }
  return { ...actual, default: { ...actual.default, Client: MockClient } }
})

// ── Imports (after mocks are registered) ─────────────────────────────────────

import { checkPendingMigrations, PendingMigrationsError } from '../src/db/migrate.js'
import * as fsModule from 'fs'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Configure the fs mock to expose a set of migration filenames on disk. */
function mockMigrationsOnDisk(files: string[]) {
  ;(fsModule.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
  ;(fsModule.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(files)
}

/**
 * Configure the pg.Client mock to report a set of applied migration names.
 * First query: table-existence check → exists: true
 * Second query: SELECT name FROM pgmigrations
 */
function mockAppliedMigrations(names: string[]) {
  pgClientMocks.query
    .mockResolvedValueOnce({ rows: [{ exists: true }] })
    .mockResolvedValueOnce({ rows: names.map((name) => ({ name })) })
}

/** Configure the pg.Client mock to simulate a missing pgmigrations table. */
function mockNoMigrationsTable() {
  pgClientMocks.query.mockResolvedValueOnce({ rows: [{ exists: false }] })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkPendingMigrations', () => {
  const ORIGINAL_ENV = process.env.DATABASE_URL

  beforeEach(() => {
    vi.clearAllMocks()
    pgClientMocks.connect.mockResolvedValue(undefined)
    pgClientMocks.end.mockResolvedValue(undefined)
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/fluxora'
  })

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = ORIGINAL_ENV
    }
  })

  // ── Missing env var ─────────────────────────────────────────────────────────

  it('throws when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL
    await expect(checkPendingMigrations()).rejects.toThrow('DATABASE_URL')
  })

  // ── All applied ─────────────────────────────────────────────────────────────

  it('resolves when all migrations on disk are applied', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts', '002_add_audit.ts'])
    mockAppliedMigrations(['001_create_streams', '002_add_audit'])
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
  })

  // ── Short-circuit paths (no DB call) ────────────────────────────────────────

  it('resolves without querying DB when no migration files exist on disk', async () => {
    mockMigrationsOnDisk([])
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
    // pg.Client.connect must not have been called
    expect(pgClientMocks.connect).not.toHaveBeenCalled()
  })

  it('resolves without querying DB when migrations directory does not exist', async () => {
    ;(fsModule.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
    expect(pgClientMocks.connect).not.toHaveBeenCalled()
  })

  // ── Pending migrations ──────────────────────────────────────────────────────

  it('throws PendingMigrationsError when one migration is unapplied', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts', '002_add_audit.ts'])
    mockAppliedMigrations(['001_create_streams']) // 002 is missing

    await expect(checkPendingMigrations()).rejects.toThrow(PendingMigrationsError)
  })

  it('PendingMigrationsError.pending lists only the unapplied names', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts', '002_add_audit.ts'])
    mockAppliedMigrations(['001_create_streams'])

    let caught: unknown
    try {
      await checkPendingMigrations()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toEqual(['002_add_audit'])
    expect(err.message).toContain('002_add_audit')
    expect(err.message).toContain('1 pending migration')
  })

  it('PendingMigrationsError.pending includes all unapplied names', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts', '002_add_audit.ts', '003_webhooks.ts'])
    mockAppliedMigrations([]) // none applied

    let caught: unknown
    try {
      await checkPendingMigrations()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toHaveLength(3)
    expect(err.pending).toContain('001_create_streams')
    expect(err.pending).toContain('002_add_audit')
    expect(err.pending).toContain('003_webhooks')
  })

  // ── Missing pgmigrations table ──────────────────────────────────────────────

  it('throws PendingMigrationsError when pgmigrations table is absent but files exist', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts'])
    mockNoMigrationsTable()

    await expect(checkPendingMigrations()).rejects.toThrow(PendingMigrationsError)
  })

  // ── DB errors ───────────────────────────────────────────────────────────────

  it('propagates DB connection errors', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts'])
    pgClientMocks.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(checkPendingMigrations()).rejects.toThrow('ECONNREFUSED')
  })

  it('closes the DB client even when a query throws', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts'])
    pgClientMocks.query.mockRejectedValueOnce(new Error('query error'))

    await expect(checkPendingMigrations()).rejects.toThrow('query error')
    expect(pgClientMocks.end).toHaveBeenCalled()
  })
})
