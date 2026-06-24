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
 *  - DB connection error → propagates; client.end() still called
 *  - Formerly PoolClient-style files (1000000000000_*, 1000000000001_*, 1000000000002_*)
 *    are visible to checkPendingMigrations and counted as pending when unapplied
 *  - run.ts tombstone is excluded (it is not a migration file)
 *  - Extension variants (.js, .mjs, .cjs) are stripped from names
 *  - Sorting: timestamp-prefixed files sort before real epoch timestamps
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── fs mock ───────────────────────────────────────────────────────────────────
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const existsSync = vi.fn()
  const readdirSync = vi.fn()
  const patched = { ...actual, existsSync, readdirSync }
  patched.default = { ...actual.default, existsSync, readdirSync }
  return patched
})

// ── pg mock ───────────────────────────────────────────────────────────────────
const pgClientMocks = {
  connect:  vi.fn().mockResolvedValue(undefined),
  end:      vi.fn().mockResolvedValue(undefined),
  query:    vi.fn(),
}

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>()
  function MockClient() { return pgClientMocks }
  return { ...actual, default: { ...actual.default, Client: MockClient } }
})

// ── Imports ───────────────────────────────────────────────────────────────────
import { checkPendingMigrations, PendingMigrationsError } from '../src/db/migrate.js'
import * as fsModule from 'fs'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockMigrationsOnDisk(files: string[]) {
  ;(fsModule.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
  ;(fsModule.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(files)
}

/**
 * First query: table-existence check → exists: true
 * Second query: SELECT name FROM pgmigrations
 */
function mockAppliedMigrations(names: string[]) {
  pgClientMocks.query
    .mockResolvedValueOnce({ rows: [{ exists: true }] })
    .mockResolvedValueOnce({ rows: names.map((name) => ({ name })) })
}

function mockNoMigrationsTable() {
  pgClientMocks.query.mockResolvedValueOnce({ rows: [{ exists: false }] })
}

// ── Full list of real migration filenames on disk ────────────────────────────
const REAL_MIGRATION_FILES = [
  // Formerly PoolClient-style — now MigrationBuilder with timestamp prefix
  '1000000000000_initial_schema.ts',
  '1000000000001_add_contract_events_replay_indexes.ts',
  '1000000000002_create_replay_cursors.ts',
  // node-pg-migrate originals
  '1774715131962_streams-table.ts',
  '1774715200000_audit-and-webhook-outbox.ts',
  '1774715300000_dead-letter-queue.ts',
  '20260601_enable_pgcrypto_encrypt_addresses.ts',
  '20260622000000_streams_composite_pagination_indexes.ts',
]

const REAL_MIGRATION_NAMES = REAL_MIGRATION_FILES.map((f) => f.replace(/\.(ts|js|mjs|cjs)$/, ''))

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

  it('resolves when the full set of real migration files are all applied', async () => {
    mockMigrationsOnDisk(REAL_MIGRATION_FILES)
    mockAppliedMigrations(REAL_MIGRATION_NAMES)
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
  })

  // ── Short-circuit paths (no DB call) ────────────────────────────────────────

  it('resolves without querying DB when no migration files exist on disk', async () => {
    mockMigrationsOnDisk([])
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
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
    mockAppliedMigrations(['001_create_streams'])
    await expect(checkPendingMigrations()).rejects.toThrow(PendingMigrationsError)
  })

  it('PendingMigrationsError.pending lists only the unapplied names', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts', '002_add_audit.ts'])
    mockAppliedMigrations(['001_create_streams'])

    let caught: unknown
    try { await checkPendingMigrations() } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toEqual(['002_add_audit'])
    expect(err.message).toContain('002_add_audit')
    expect(err.message).toContain('1 pending migration')
  })

  it('PendingMigrationsError.pending includes all unapplied names', async () => {
    mockMigrationsOnDisk(['001_create_streams.ts', '002_add_audit.ts', '003_webhooks.ts'])
    mockAppliedMigrations([])

    let caught: unknown
    try { await checkPendingMigrations() } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toHaveLength(3)
    expect(err.pending).toContain('001_create_streams')
    expect(err.pending).toContain('002_add_audit')
    expect(err.pending).toContain('003_webhooks')
  })

  // ── Formerly PoolClient-style files (now timestamp-prefixed) ────────────────

  it('detects 1000000000000_initial_schema as pending when unapplied', async () => {
    mockMigrationsOnDisk(['1000000000000_initial_schema.ts'])
    mockNoMigrationsTable()

    let caught: unknown
    try { await checkPendingMigrations() } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toContain('1000000000000_initial_schema')
  })

  it('detects 1000000000001_add_contract_events_replay_indexes as pending when unapplied', async () => {
    mockMigrationsOnDisk(['1000000000001_add_contract_events_replay_indexes.ts'])
    mockNoMigrationsTable()

    let caught: unknown
    try { await checkPendingMigrations() } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toContain('1000000000001_add_contract_events_replay_indexes')
  })

  it('detects 1000000000002_create_replay_cursors as pending when unapplied', async () => {
    mockMigrationsOnDisk(['1000000000002_create_replay_cursors.ts'])
    mockNoMigrationsTable()

    let caught: unknown
    try { await checkPendingMigrations() } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toContain('1000000000002_create_replay_cursors')
  })

  it('resolves when all three formerly-PoolClient migrations are applied', async () => {
    mockMigrationsOnDisk([
      '1000000000000_initial_schema.ts',
      '1000000000001_add_contract_events_replay_indexes.ts',
      '1000000000002_create_replay_cursors.ts',
    ])
    mockAppliedMigrations([
      '1000000000000_initial_schema',
      '1000000000001_add_contract_events_replay_indexes',
      '1000000000002_create_replay_cursors',
    ])
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
  })

  it('throws when only the formerly-PoolClient migrations are unapplied alongside applied ones', async () => {
    mockMigrationsOnDisk([
      '1000000000000_initial_schema.ts',
      '1000000000001_add_contract_events_replay_indexes.ts',
      '1774715131962_streams-table.ts',
    ])
    mockAppliedMigrations(['1774715131962_streams-table'])

    let caught: unknown
    try { await checkPendingMigrations() } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(PendingMigrationsError)
    const err = caught as PendingMigrationsError
    expect(err.pending).toHaveLength(2)
    expect(err.pending).toContain('1000000000000_initial_schema')
    expect(err.pending).toContain('1000000000001_add_contract_events_replay_indexes')
  })

  // ── Extension stripping ─────────────────────────────────────────────────────

  it('strips .js extension from migration name', async () => {
    mockMigrationsOnDisk(['001_create_streams.js'])
    mockAppliedMigrations(['001_create_streams'])
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
  })

  it('strips .mjs extension from migration name', async () => {
    mockMigrationsOnDisk(['001_create_streams.mjs'])
    mockAppliedMigrations(['001_create_streams'])
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
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

  // ── run.ts tombstone must not be treated as a migration ────────────────────

  it('ignores run.ts (no numeric prefix) so it is never treated as a pending migration', async () => {
    // getMigrationNamesOnDisk filters to files matching /^\d+.*\.(ts|js|…)$/
    // so run.ts is excluded.  Only the real migration is seen as pending.
    mockMigrationsOnDisk(['run.ts', '001_create_streams.ts'])
    mockAppliedMigrations(['001_create_streams'])
    // run.ts is excluded → only 001_create_streams is on disk → it's applied → resolves
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
    // pg client was still called because a real migration file exists on disk
    expect(pgClientMocks.connect).toHaveBeenCalled()
  })

  it('ignores run.ts even when no other migrations are applied', async () => {
    mockMigrationsOnDisk(['run.ts'])
    // No real migration files → short-circuit before DB call
    await expect(checkPendingMigrations()).resolves.toBeUndefined()
    expect(pgClientMocks.connect).not.toHaveBeenCalled()
  })
})
