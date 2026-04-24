/**
 * Database Backup and Restore Operations
 *
 * Provides pg_dump / pg_restore wrappers with an optional S3 streaming target.
 *
 * ## Security notes
 * - DATABASE_URL is validated before any subprocess is spawned.
 * - Shell arguments are passed via execFile (array form) — never interpolated
 *   into a shell string — to prevent command injection.
 * - S3 credentials are consumed from environment variables only; they are
 *   never logged or included in error messages.
 * - The S3 upload uses a streaming pipeline so the dump never lands on the
 *   local filesystem when a bucket is configured.
 *
 * ## Decimal-string serialization guarantee
 * This module does not touch stream amount fields. All monetary values stored
 * in the database remain as decimal strings (TEXT columns) and are never
 * coerced to numbers here, preserving the project-wide serialization contract.
 *
 * @module scripts/db-ops
 */

import { execFile, spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { PassThrough, Readable } from 'stream'

const execFileAsync = promisify(execFile)

// ── Result type ───────────────────────────────────────────────────────────────

export interface DbOperationResult {
  success: boolean
  message: string
  /** Raw stderr / error detail — never contains credentials */
  error?: string
}

// ── S3 options ────────────────────────────────────────────────────────────────

/**
 * Optional S3 streaming target for backup uploads / restore downloads.
 *
 * Credentials are resolved from the environment at call time:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (or AWS_DEFAULT_REGION)
 *
 * The AWS SDK v3 is loaded lazily so the module remains usable without it
 * when S3 is not needed.
 */
export interface S3Target {
  /** S3 bucket name */
  bucket: string
  /** Object key (path) inside the bucket, e.g. "backups/2026-04-23.dump" */
  key: string
  /** AWS region — falls back to AWS_REGION / AWS_DEFAULT_REGION env vars */
  region?: string
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate that a DATABASE_URL looks like a postgres connection string.
 * Rejects empty strings and non-postgres schemes before any subprocess spawns.
 */
function validateDatabaseUrl(url: string): { valid: boolean; reason?: string } {
  if (!url || url.trim() === '') {
    return { valid: false, reason: 'DATABASE_URL is required but was not provided.' }
  }
  if (!/^postgre(?:s|sql):\/\//i.test(url)) {
    return { valid: false, reason: 'DATABASE_URL must be a valid PostgreSQL connection string.' }
  }
  return { valid: true }
}

/**
 * Validate a filesystem path — must be non-empty and must not contain
 * shell metacharacters that could escape argument boundaries even when
 * passed via execFile.
 */
function validatePath(p: string, label: string): { valid: boolean; reason?: string } {
  if (!p || p.trim() === '') {
    return { valid: false, reason: `${label} path is required but was not provided.` }
  }
  if (/[\0`$|;&<>]/.test(p)) {
    return { valid: false, reason: `${label} path contains invalid characters.` }
  }
  return { valid: true }
}

// ── S3 upload helper ──────────────────────────────────────────────────────────

/**
 * Stream a Readable directly into S3 using the AWS SDK v3.
 * Loaded lazily — throws a clear error if the SDK is not installed.
 *
 * @internal
 */
async function uploadStreamToS3(readable: Readable, target: S3Target): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let S3Client: any, Upload: any
  try {
    // @ts-ignore — @aws-sdk/client-s3 is an optional peer dependency
    const s3Mod = await import('@aws-sdk/client-s3')
    // @ts-ignore — @aws-sdk/lib-storage is an optional peer dependency
    const uploadMod = await import('@aws-sdk/lib-storage')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    S3Client = s3Mod.S3Client
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    Upload = uploadMod.Upload
  } catch {
    throw new Error(
      'AWS SDK v3 is not installed. Run: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage',
    )
  }

  const region =
    target.region ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    'us-east-1'

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const client = new S3Client({ region })

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const upload = new Upload({
    client,
    params: { Bucket: target.bucket, Key: target.key, Body: readable },
    partSize: 5 * 1024 * 1024, // 5 MiB parts
    queueSize: 4,
  })

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  await upload.done()
}

// ── backupDatabase ────────────────────────────────────────────────────────────

/**
 * Create a custom-format PostgreSQL backup using pg_dump.
 *
 * When `s3Target` is provided the dump is streamed directly to S3 via a
 * PassThrough pipe — no temporary file is written to disk.
 *
 * When `s3Target` is omitted the dump is written to `outputPath` on the
 * local filesystem.
 *
 * @param databaseUrl  PostgreSQL connection string
 * @param outputPath   Local file path for the dump (ignored when s3Target is set)
 * @param s3Target     Optional S3 bucket/key to stream the dump to
 *
 * @example — local backup
 * ```ts
 * const result = await backupDatabase(process.env.DATABASE_URL!, './backup.dump')
 * ```
 *
 * @example — S3 streaming backup
 * ```ts
 * const result = await backupDatabase(
 *   process.env.DATABASE_URL!,
 *   '',   // ignored when s3Target is set
 *   { bucket: 'my-backups', key: 'fluxora/2026-04-23.dump' },
 * )
 * ```
 */
export async function backupDatabase(
  databaseUrl: string,
  outputPath: string,
  s3Target?: S3Target,
): Promise<DbOperationResult> {
  const urlCheck = validateDatabaseUrl(databaseUrl)
  if (!urlCheck.valid) {
    return { success: false, message: urlCheck.reason! }
  }

  if (!s3Target) {
    const pathCheck = validatePath(outputPath, 'Output')
    if (!pathCheck.valid) {
      return { success: false, message: pathCheck.reason! }
    }
  }

  try {
    if (s3Target) {
      // ── S3 streaming path ────────────────────────────────────────────────
      // Spawn pg_dump writing to stdout, pipe directly to S3 upload.
      const args = ['--format=custom', '--no-password', databaseUrl]
      const child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })

      const passThrough = new PassThrough()
      ;(child.stdout as Readable).pipe(passThrough)

      let stderrOutput = ''
      ;(child.stderr as Readable).on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString()
      })

      // Run S3 upload and wait for process exit concurrently
      const uploadPromise = uploadStreamToS3(passThrough, s3Target)

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })

      await uploadPromise

      if (exitCode !== 0) {
        return {
          success: false,
          message: 'Backup failed',
          error: stderrOutput || `pg_dump exited with code ${exitCode}`,
        }
      }

      return {
        success: true,
        message: `Backup successfully streamed to s3://${s3Target.bucket}/${s3Target.key}`,
      }
    } else {
      // ── Local file path ──────────────────────────────────────────────────
      // execFile avoids shell interpolation — args are passed as an array.
      const args = [
        '--format=custom',
        '--no-password',
        `--file=${outputPath}`,
        databaseUrl,
      ]

      await execFileAsync('pg_dump', args)

      return {
        success: true,
        message: `Backup successfully written to ${outputPath}`,
      }
    }
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string }
    const errorMsg =
      err.stderr?.trim() ||
      err.message ||
      'Unknown error occurred during pg_dump'
    return { success: false, message: 'Backup failed', error: errorMsg }
  }
}

// ── restoreDatabase ───────────────────────────────────────────────────────────

/**
 * Restore a custom-format PostgreSQL backup using pg_restore.
 *
 * When `s3Source` is provided the dump is downloaded from S3 and streamed
 * directly into pg_restore via stdin — no temporary file is written to disk.
 *
 * When `s3Source` is omitted the dump is read from `inputPath` on the local
 * filesystem.
 *
 * **WARNING**: Uses `--clean` which drops existing database objects before
 * recreating them. Ensure no active connections exist before running in
 * production.
 *
 * @param databaseUrl  PostgreSQL connection string
 * @param inputPath    Local file path of the dump (ignored when s3Source is set)
 * @param s3Source     Optional S3 bucket/key to stream the dump from
 *
 * @example — local restore
 * ```ts
 * const result = await restoreDatabase(process.env.DATABASE_URL!, './backup.dump')
 * ```
 *
 * @example — S3 streaming restore
 * ```ts
 * const result = await restoreDatabase(
 *   process.env.DATABASE_URL!,
 *   '',   // ignored when s3Source is set
 *   { bucket: 'my-backups', key: 'fluxora/2026-04-23.dump' },
 * )
 * ```
 */
export async function restoreDatabase(
  databaseUrl: string,
  inputPath: string,
  s3Source?: S3Target,
): Promise<DbOperationResult> {
  const urlCheck = validateDatabaseUrl(databaseUrl)
  if (!urlCheck.valid) {
    return { success: false, message: urlCheck.reason! }
  }

  if (!s3Source) {
    const pathCheck = validatePath(inputPath, 'Input')
    if (!pathCheck.valid) {
      return { success: false, message: pathCheck.reason! }
    }
  }

  try {
    if (s3Source) {
      // ── S3 streaming path ────────────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let S3Client: any, GetObjectCommand: any
      try {
        // @ts-ignore — @aws-sdk/client-s3 is an optional peer dependency
        const s3Mod = await import('@aws-sdk/client-s3')
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        S3Client = s3Mod.S3Client
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        GetObjectCommand = s3Mod.GetObjectCommand
      } catch {
        return {
          success: false,
          message: 'Restore failed',
          error: 'AWS SDK v3 is not installed. Run: npm install @aws-sdk/client-s3',
        }
      }

      const region =
        s3Source.region ??
        process.env['AWS_REGION'] ??
        process.env['AWS_DEFAULT_REGION'] ??
        'us-east-1'

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      const client = new S3Client({ region })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      const response = await client.send(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        new GetObjectCommand({ Bucket: s3Source.bucket, Key: s3Source.key }),
      ) as { Body?: Readable }

      if (!response.Body) {
        return {
          success: false,
          message: 'Restore failed',
          error: `S3 object s3://${s3Source.bucket}/${s3Source.key} returned an empty body`,
        }
      }

      // --clean drops objects before recreating; --no-owner skips ownership
      // restoration so the dump is portable across environments.
      const args = [
        '--clean',
        '--no-owner',
        '--no-password',
        `--dbname=${databaseUrl}`,
      ]

      const child = spawn('pg_restore', args, { stdio: ['pipe', 'pipe', 'pipe'] })

      let stderrOutput = ''
      ;(child.stderr as Readable).on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString()
      })

      // Pipe S3 body stream into pg_restore stdin
      await pipeline(response.Body, child.stdin)

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })

      if (exitCode !== 0) {
        return {
          success: false,
          message: 'Restore failed',
          error: stderrOutput || `pg_restore exited with code ${exitCode}`,
        }
      }

      return {
        success: true,
        message: `Restore successfully completed from s3://${s3Source.bucket}/${s3Source.key}`,
      }
    } else {
      // ── Local file path ──────────────────────────────────────────────────
      const args = [
        '--clean',
        '--no-owner',
        '--no-password',
        `--dbname=${databaseUrl}`,
        inputPath,
      ]

      await execFileAsync('pg_restore', args)

      return {
        success: true,
        message: `Restore successfully completed from ${inputPath}`,
      }
    }
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string }
    const errorMsg =
      err.stderr?.trim() ||
      err.message ||
      'Unknown error occurred during pg_restore'
    return { success: false, message: 'Restore failed', error: errorMsg }
  }
}
