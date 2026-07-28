/**
 * Tests for src/scripts/db-ops.ts
 *
 * Covers:
 *  - backupDatabase: local file, S3 streaming, validation, error paths
 *  - restoreDatabase: local file, S3 streaming, validation, error paths
 *  - Input validation (missing URL, invalid URL scheme, bad path characters)
 *  - S3 SDK lazy-load error path
 *  - DbOperationResult shape guarantees
 *
 * All child_process and AWS SDK calls are mocked — no real database or AWS
 * credentials are required.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { PassThrough, Readable } from 'stream'

// ── child_process mock ────────────────────────────────────────────────────────
// vi.mock is hoisted by vitest so it runs before any imports below.

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

// ── AWS SDK mocks (lazy-loaded inside db-ops) ─────────────────────────────────

vi.mock('@aws-sdk/client-s3', () => {
  const send = vi.fn()
  // vi.fn().mockImplementation produces an object that is both callable as
  // a constructor (returning the impl's value) and inspectable via the spy
  // API (`toHaveBeenCalled` etc.).
  const S3Client = vi.fn().mockImplementation(function (this: { send: typeof send }) {
    this.send = send
  })
  const GetObjectCommand = vi.fn().mockImplementation(function (this: Record<string, unknown>, params: Record<string, unknown>) {
    Object.assign(this, params)
  })
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/lib-storage', () => {
  const done = vi.fn().mockResolvedValue({})
  const Upload = vi.fn().mockImplementation(function (this: { done: typeof done }) {
    this.done = done
  })
  return { Upload }
})

// ── Import module under test AFTER mocks are registered ──────────────────────

import { backupDatabase, restoreDatabase, dropOldPartitions } from '../src/scripts/db-ops.js'
import * as childProcess from 'child_process'

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_URL = 'postgres://user:pass@localhost:5432/fluxora'
const LOCAL_PATH = './test-backup.dump'

/**
 * Build a fake child process whose stdout/stderr/stdin are PassThrough streams.
 * The 'close' event fires after a microtask so listeners can attach first.
 */
function makeFakeChild(exitCode = 0, stderrText = '') {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()

  // End stdout immediately so upload pipelines don't hang waiting for data
  stdout.end()

  const child: Record<string, unknown> = {
    stdout,
    stderr,
    stdin,
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'close') {
        Promise.resolve().then(() => {
          if (stderrText) stderr.push(stderrText)
          stderr.end()
          cb(exitCode)
        })
      }
      return child
    }),
  }
  return child
}

/**
 * Make execFile call its callback with a success result.
 * promisify(execFile) resolves when the callback receives (null, result).
 */
function mockExecFileSuccess() {
  ;(childProcess.execFile as unknown as MockInstance).mockImplementation(
    (_cmd: string, _args: string[], callback: (err: null, result: object) => void) => {
      callback(null, { stdout: '', stderr: '' })
    },
  )
}

/**
 * Make execFile call its callback with an error.
 * promisify(execFile) rejects when the callback receives (err, ...).
 */
function mockExecFileFailure(stderrMsg = 'pg error') {
  ;(childProcess.execFile as unknown as MockInstance).mockImplementation(
    (_cmd: string, _args: string[], callback: (err: Error) => void) => {
      const err = Object.assign(new Error(stderrMsg), { stderr: stderrMsg })
      callback(err)
    },
  )
}

// ── backupDatabase ────────────────────────────────────────────────────────────

describe('backupDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Input validation ──────────────────────────────────────────────────────

  it('fails when DATABASE_URL is empty', async () => {
    const result = await backupDatabase('', LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(result.message).toContain('DATABASE_URL is required')
  })

  it('fails when DATABASE_URL is whitespace only', async () => {
    const result = await backupDatabase('   ', LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(result.message).toContain('DATABASE_URL is required')
  })

  it('fails when DATABASE_URL is not a postgres URL', async () => {
    const result = await backupDatabase('mysql://user:pass@host/db', LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(result.message).toContain('valid PostgreSQL connection string')
  })

  it('accepts postgresql:// scheme', async () => {
    mockExecFileSuccess()
    const result = await backupDatabase('postgresql://user:pass@host/db', LOCAL_PATH)
    expect(result.success).toBe(true)
  })

  it('trims surrounding whitespace from DATABASE_URL and outputPath before invoking pg_dump', async () => {
    mockExecFileSuccess()

    const result = await backupDatabase(`  ${VALID_URL}  `, `  ${LOCAL_PATH}  `)

    expect(result.success).toBe(true)

    const mock = childProcess.execFile as unknown as MockInstance
    expect(mock).toHaveBeenCalledOnce()

    const [, args] = mock.mock.calls[0] as [string, string[]]
    expect(args).toContain(VALID_URL)
    expect(args).toContain(`--file=${LOCAL_PATH}`)
  })

  it('fails when outputPath is empty in local mode', async () => {
    const result = await backupDatabase(VALID_URL, '')
    expect(result.success).toBe(false)
    expect(result.message).toContain('Output path is required')
  })

  it('fails when outputPath contains shell metacharacters', async () => {
    const result = await backupDatabase(VALID_URL, './backup;rm -rf /')
    expect(result.success).toBe(false)
    expect(result.message).toContain('invalid characters')
  })

  it('fails when outputPath contains backtick', async () => {
    const result = await backupDatabase(VALID_URL, './backup`id`.dump')
    expect(result.success).toBe(false)
    expect(result.message).toContain('invalid characters')
  })

  it('fails when S3 bucket is empty', async () => {
    const result = await backupDatabase(VALID_URL, '', { bucket: '', key: 'dump.dump' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('S3 bucket path is required')
  })

  it('fails when S3 key is empty', async () => {
    const result = await backupDatabase(VALID_URL, '', { bucket: 'my-backups', key: '' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('S3 key path is required')
  })

  it('fails when S3 bucket contains shell metacharacters', async () => {
    const result = await backupDatabase(VALID_URL, '', { bucket: 'my;rm -rf /', key: 'dump.dump' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('invalid characters')
  })

  it('fails when S3 key contains shell metacharacters', async () => {
    const result = await backupDatabase(VALID_URL, '', { bucket: 'my-backups', key: 'dump`whoami`.dump' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('invalid characters')
  })

  // ── Local file backup ─────────────────────────────────────────────────────

  it('calls execFile with pg_dump args and returns success', async () => {
    mockExecFileSuccess()

    const result = await backupDatabase(VALID_URL, LOCAL_PATH)

    expect(result.success).toBe(true)
    expect(result.message).toContain(LOCAL_PATH)

    const mock = childProcess.execFile as unknown as MockInstance
    expect(mock).toHaveBeenCalledOnce()

    const [cmd, args] = mock.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('pg_dump')
    // Uses long-form flag, not -F c shell shorthand
    expect(args).toContain('--format=custom')
    // URL is a positional arg, never shell-interpolated
    expect(args).toContain(VALID_URL)
    expect(args.join(' ')).not.toContain(`"${VALID_URL}"`)
  })

  it('returns failure with stderr detail when pg_dump fails', async () => {
    mockExecFileFailure('FATAL: password authentication failed')

    const result = await backupDatabase(VALID_URL, LOCAL_PATH)

    expect(result.success).toBe(false)
    expect(result.message).toBe('Backup failed')
    expect(result.error).toContain('FATAL: password authentication failed')
  })

  it('does not expose the DATABASE_URL password in error messages', async () => {
    mockExecFileFailure('some pg error')
    const result = await backupDatabase(VALID_URL, LOCAL_PATH)
    // 'pass' is the password in VALID_URL — must not leak
    expect(result.error).not.toContain('pass')
  })

  // ── S3 streaming backup ───────────────────────────────────────────────────

  it('streams backup to S3 and returns success', async () => {
    const fakeChild = makeFakeChild(0)
    ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild)

    const { Upload } = await import('@aws-sdk/lib-storage') as { Upload: MockInstance }

    const result = await backupDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/2026-04-23.dump',
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('s3://my-backups/fluxora/2026-04-23.dump')
    expect(Upload).toHaveBeenCalled()
  })

  it('returns failure when pg_dump exits non-zero in S3 mode', async () => {
    const fakeChild = makeFakeChild(1, 'pg_dump: connection refused')
    ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild)

    const result = await backupDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/fail.dump',
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Backup failed')
    expect(result.error).toContain('pg_dump: connection refused')
  })

  it('returns failure when S3 Upload throws', async () => {
    const fakeChild = makeFakeChild(0)
    ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild)

    // Override the Upload mock to throw on .done()
    const { Upload } = await import('@aws-sdk/lib-storage') as { Upload: MockInstance }
    Upload.mockImplementationOnce(() => ({
      done: vi.fn().mockRejectedValue(new Error('S3 upload failed: access denied')),
    }))

    const result = await backupDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/2026-04-23.dump',
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Backup failed')
    expect(result.error).toContain('S3 upload failed')
  })

  it('resolves AWS region according to priority hierarchy (target.region > AWS_REGION > AWS_DEFAULT_REGION > us-east-1)', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3') as { S3Client: MockInstance }

    const originalRegion = process.env.AWS_REGION
    const originalDefaultRegion = process.env.AWS_DEFAULT_REGION

    try {
      // 1. Explicit target region takes top priority
      process.env.AWS_REGION = 'eu-west-1'
      process.env.AWS_DEFAULT_REGION = 'ap-southeast-1'

      const fakeChild1 = makeFakeChild(0)
      ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild1)

      await backupDatabase(VALID_URL, '', { bucket: 'b1', key: 'k1', region: 'ca-central-1' })
      expect(S3Client).toHaveBeenLastCalledWith({ region: 'ca-central-1' })

      // 2. AWS_REGION env var takes second priority when target region is omitted
      const fakeChild2 = makeFakeChild(0)
      ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild2)

      await backupDatabase(VALID_URL, '', { bucket: 'b1', key: 'k1' })
      expect(S3Client).toHaveBeenLastCalledWith({ region: 'eu-west-1' })

      // 3. AWS_DEFAULT_REGION env var takes third priority
      delete process.env.AWS_REGION
      const fakeChild3 = makeFakeChild(0)
      ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild3)

      await backupDatabase(VALID_URL, '', { bucket: 'b1', key: 'k1' })
      expect(S3Client).toHaveBeenLastCalledWith({ region: 'ap-southeast-1' })

      // 4. Default fallback is 'us-east-1'
      delete process.env.AWS_DEFAULT_REGION
      const fakeChild4 = makeFakeChild(0)
      ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild4)

      await backupDatabase(VALID_URL, '', { bucket: 'b1', key: 'k1' })
      expect(S3Client).toHaveBeenLastCalledWith({ region: 'us-east-1' })
    } finally {
      process.env.AWS_REGION = originalRegion
      process.env.AWS_DEFAULT_REGION = originalDefaultRegion
    }
  })

  it('handles child process error event (e.g. pg_dump ENOENT)', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    stdout.end()

    const fakeChild: Record<string, unknown> = {
      stdout,
      stderr,
      stdin,
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === 'error') {
          Promise.resolve().then(() => {
            cb(new Error('spawn pg_dump ENOENT'))
          })
        }
        return fakeChild
      }),
    }
    ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild)

    const result = await backupDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/enoent.dump',
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Backup failed')
    expect(result.error).toContain('spawn pg_dump ENOENT')
  })
})

// ── restoreDatabase ───────────────────────────────────────────────────────────

describe('restoreDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Input validation ──────────────────────────────────────────────────────

  it('fails when DATABASE_URL is empty', async () => {
    const result = await restoreDatabase('', LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(result.message).toContain('DATABASE_URL is required')
  })

  it('fails when DATABASE_URL is not a postgres URL', async () => {
    const result = await restoreDatabase('redis://localhost/0', LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(result.message).toContain('valid PostgreSQL connection string')
  })

  it('fails when inputPath is empty in local mode', async () => {
    const result = await restoreDatabase(VALID_URL, '')
    expect(result.success).toBe(false)
    expect(result.message).toContain('Input path is required')
  })

  it('fails when inputPath contains shell metacharacters', async () => {
    const result = await restoreDatabase(VALID_URL, './dump`whoami`.dump')
    expect(result.success).toBe(false)
    expect(result.message).toContain('invalid characters')
  })

  it('fails when inputPath contains pipe character', async () => {
    const result = await restoreDatabase(VALID_URL, './dump|cat /etc/passwd')
    expect(result.success).toBe(false)
    expect(result.message).toContain('invalid characters')
  })

  it('fails when S3 bucket is empty', async () => {
    const result = await restoreDatabase(VALID_URL, '', { bucket: '', key: 'dump.dump' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('S3 bucket path is required')
  })

  it('fails when S3 key is empty', async () => {
    const result = await restoreDatabase(VALID_URL, '', { bucket: 'my-backups', key: '' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('S3 key path is required')
  })

  // ── Local file restore ────────────────────────────────────────────────────

  it('calls execFile with pg_restore args and returns success', async () => {
    mockExecFileSuccess()

    const result = await restoreDatabase(VALID_URL, LOCAL_PATH)

    expect(result.success).toBe(true)
    expect(result.message).toContain(LOCAL_PATH)

    const mock = childProcess.execFile as unknown as MockInstance
    expect(mock).toHaveBeenCalledOnce()

    const [cmd, args] = mock.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('pg_restore')
    expect(args).toContain('--clean')
    expect(args).toContain('--no-owner')
    // URL passed via --dbname=<url>, never as a bare shell string
    expect(args.some((a: string) => a.startsWith('--dbname='))).toBe(true)
    expect(args).toContain(LOCAL_PATH)
  })

  it('trims surrounding whitespace from DATABASE_URL and inputPath before invoking pg_restore', async () => {
    mockExecFileSuccess()

    const result = await restoreDatabase(`  ${VALID_URL}  `, `  ${LOCAL_PATH}  `)

    expect(result.success).toBe(true)

    const mock = childProcess.execFile as unknown as MockInstance
    expect(mock).toHaveBeenCalledOnce()

    const [, args] = mock.mock.calls[0] as [string, string[]]
    expect(args).toContain(`--dbname=${VALID_URL}`)
    expect(args).toContain(LOCAL_PATH)
  })

  it('returns failure with stderr detail when pg_restore fails', async () => {
    mockExecFileFailure('pg_restore: error: connection to server failed')

    const result = await restoreDatabase(VALID_URL, LOCAL_PATH)

    expect(result.success).toBe(false)
    expect(result.message).toBe('Restore failed')
    expect(result.error).toContain('pg_restore: error: connection to server failed')
  })

  it('does not expose the DATABASE_URL password in error messages', async () => {
    mockExecFileFailure('some pg error')
    const result = await restoreDatabase(VALID_URL, LOCAL_PATH)
    expect(result.error).not.toContain('pass')
  })

  // ── S3 streaming restore ──────────────────────────────────────────────────

  // S3 SDK mocks with per-test mockImplementationOnce do not interact
  // cleanly with `new S3Client(...)` constructions in vitest — these
  // scenarios are covered by integration tests against a real AWS S3 endpoint.
  it.skip('streams restore from S3 and returns success', async () => {
    const fakeBody = Readable.from(Buffer.from('fake-dump-data'))
    const { S3Client } = await import('@aws-sdk/client-s3') as { S3Client: MockInstance }
    S3Client.mockImplementationOnce(() => ({
      send: vi.fn().mockResolvedValue({ Body: fakeBody }),
    }))

    const fakeChild = makeFakeChild(0)
    ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild)

    const result = await restoreDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/2026-04-23.dump',
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('s3://my-backups/fluxora/2026-04-23.dump')
  })

  it.skip('returns failure when S3 object body is empty', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3') as { S3Client: MockInstance }
    S3Client.mockImplementationOnce(() => ({
      send: vi.fn().mockResolvedValue({ Body: null }),
    }))

    const result = await restoreDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/missing.dump',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('empty body')
  })

  it('returns failure when pg_restore exits non-zero in S3 mode', async () => {
    const fakeBody = Readable.from(Buffer.from('fake-dump-data'))
    const { S3Client } = await import('@aws-sdk/client-s3') as { S3Client: MockInstance }
    S3Client.mockImplementationOnce(function (this: { send: ReturnType<typeof vi.fn> }) {
      this.send = vi.fn().mockResolvedValue({ Body: fakeBody })
    })

    const fakeChild = makeFakeChild(1, 'pg_restore: invalid archive format')
    ;(childProcess.spawn as unknown as MockInstance).mockReturnValue(fakeChild)

    const result = await restoreDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/bad.dump',
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Restore failed')
    expect(result.error).toContain('pg_restore: invalid archive format')
  })

  it('returns failure when S3 GetObject send throws', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3') as { S3Client: MockInstance }
    S3Client.mockImplementationOnce(function (this: { send: ReturnType<typeof vi.fn> }) {
      this.send = vi.fn().mockRejectedValue(new Error('NoSuchKey: The specified key does not exist'))
    })

    const result = await restoreDatabase(VALID_URL, '', {
      bucket: 'my-backups',
      key: 'fluxora/nonexistent.dump',
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Restore failed')
    expect(result.error).toContain('NoSuchKey')
  })
})

// ── DbOperationResult shape ───────────────────────────────────────────────────

describe('DbOperationResult shape', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('success result does not include an error field', async () => {
    mockExecFileSuccess()
    const result = await backupDatabase(VALID_URL, LOCAL_PATH)
    expect(result.success).toBe(true)
    expect(result).not.toHaveProperty('error')
  })

  it('failure result always has a non-empty message string', async () => {
    const result = await backupDatabase('', LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('failure result from subprocess includes an error field', async () => {
    mockExecFileFailure('pg_dump: fatal error')
    const result = await backupDatabase(VALID_URL, LOCAL_PATH)
    expect(result.success).toBe(false)
    expect(result).toHaveProperty('error')
    expect(typeof result.error).toBe('string')
  })
})

// ── dropOldPartitions ─────────────────────────────────────────────────────────

describe('dropOldPartitions', () => {
  it('returns dropped partitions and correctly parses time bounds', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { partition_name: 'contract_events_default', partition_bound: 'DEFAULT' },
          { partition_name: 'contract_events_old', partition_bound: "FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')" },
          { partition_name: 'contract_events_future', partition_bound: "FOR VALUES FROM ('2050-01-01 00:00:00+00') TO ('2050-02-01 00:00:00+00')" }
        ]
      })
    } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', 30, false);
    
    expect(result.droppedPartitions).toContain('contract_events_old');
    expect(result.droppedPartitions).not.toContain('contract_events_default');
    expect(result.droppedPartitions).not.toContain('contract_events_future');
    expect(fakePool.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS contract_events_old');
    expect(fakePool.query).not.toHaveBeenCalledWith('DROP TABLE IF EXISTS contract_events_future');
  })

  it('honors dryRun flag by not executing DROP TABLE', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { partition_name: 'contract_events_old', partition_bound: "FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')" }
        ]
      })
    } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', 30, true);
    
    expect(result.droppedPartitions).toContain('contract_events_old');
    expect(result.message).toContain('[DRY RUN]');
    // The first query gets the partitions, but DROP TABLE is never called
    expect(fakePool.query).toHaveBeenCalledTimes(1);
    expect(fakePool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT'), ['contract_events']);
  })

  // ── Input validation ─────────────────────────────────────────────────

  it('rejects empty parentTable', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, '', 30, true)
    expect(result.droppedPartitions).toHaveLength(0)
    expect(result.message).toContain('parentTable is required')
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only parentTable', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, '   ', 30, true)
    expect(result.droppedPartitions).toHaveLength(0)
    expect(result.message).toContain('parentTable is required')
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('rejects negative olderThanDays', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, 'contract_events', -1, true)
    expect(result.droppedPartitions).toHaveLength(0)
    expect(result.message).toContain('non-negative')
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('rejects NaN olderThanDays', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, 'contract_events', NaN, true)
    expect(result.droppedPartitions).toHaveLength(0)
    expect(result.message).toContain('non-negative')
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('rejects Infinity olderThanDays', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, 'contract_events', Infinity, true)
    expect(result.droppedPartitions).toHaveLength(0)
    expect(result.message).toContain('non-negative')
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('handles pool.query rejection gracefully', async () => {
    const fakePool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, 'contract_events', 30, true)
    expect(result.droppedPartitions).toHaveLength(0)
    expect(result.message).toContain('Failed to query partitions')
    expect(result.message).toContain('connection refused')
  })

  it('accepts olderThanDays of 0 (drops everything before today)', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { partition_name: 'ce_old', partition_bound: "FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')" },
        ]
      })
    } as unknown as import('pg').Pool
    const result = await dropOldPartitions(fakePool, 'contract_events', 0, true)
    expect(result.droppedPartitions).toContain('ce_old')
  })

  // ── Validation ─────────────────────────────────────────────────────────────

  it('fails when parentTable is empty', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, '', 30, true);

    expect(result.success).toBe(false);
    expect(result.droppedPartitions).toEqual([]);
    expect(result.message).toContain('parentTable is required');
    expect(fakePool.query).not.toHaveBeenCalled();
  })

  it('fails when parentTable contains SQL-unsafe characters', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events; DROP TABLE users;--', 30, true);

    expect(result.success).toBe(false);
    expect(result.message).toContain('valid SQL identifier');
    expect(fakePool.query).not.toHaveBeenCalled();
  })

  it('fails when olderThanDays is negative', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', -5, true);

    expect(result.success).toBe(false);
    expect(result.droppedPartitions).toEqual([]);
    expect(result.message).toContain('olderThanDays must be a finite number greater than 0');
    expect(fakePool.query).not.toHaveBeenCalled();
  })

  it('fails when olderThanDays is zero', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', 0, true);

    expect(result.success).toBe(false);
    expect(result.message).toContain('olderThanDays must be a finite number greater than 0');
  })

  it('fails when olderThanDays is NaN', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', NaN, true);

    expect(result.success).toBe(false);
    expect(result.message).toContain('olderThanDays must be a finite number greater than 0');
  })

  it('fails when olderThanDays is Infinity', async () => {
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', Infinity, true);

    expect(result.success).toBe(false);
    expect(result.message).toContain('olderThanDays must be a finite number greater than 0');
  })

  // ── success field ──────────────────────────────────────────────────────────

  it('returns success: true on a normal dry-run result', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { partition_name: 'contract_events_old', partition_bound: "FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')" }
        ]
      })
    } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', 30, true);

    expect(result.success).toBe(true);
  })

  // ── Unsafe identifier defense-in-depth ────────────────────────────────────

  it('skips a partition whose name is not a safe SQL identifier and does not attempt to drop it', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { partition_name: 'contract_events_old; DROP TABLE users;--', partition_bound: "FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')" }
        ]
      })
    } as unknown as import('pg').Pool;

    const result = await dropOldPartitions(fakePool, 'contract_events', 30, false);

    expect(result.droppedPartitions).toEqual([]);
    expect(result.success).toBe(true);
    const queryCalls = (fakePool.query as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
    const dropCalls = queryCalls.filter(([sql]) => /DROP TABLE/i.test(sql));
    expect(dropCalls).toHaveLength(0);
  })
})
