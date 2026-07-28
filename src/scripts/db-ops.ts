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
import { logger } from '../lib/logger.js'

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

/**
 * Redact the credentials portion of a PostgreSQL connection string for safe
 * logging. Never log a raw DATABASE_URL — it may contain a password.
 */
function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    if (parsed.username) parsed.username = '***'
    return parsed.toString()
  } catch {
    return '[unparseable connection string]'
  }
}

/**
 * Validate the retention window for dropOldPartitions.
 * Must be a finite, positive number of days.
 */
function validateOlderThanDays(days: number): { valid: boolean; reason?: string } {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    return { valid: false, reason: 'olderThanDays must be a finite number greater than 0.' }
  }
  return { valid: true }
}

/**
 * Validate that a value is a safe, plain SQL identifier — used for both the
 * parent table name (query parameter, already safe) and, defensively, for
 * partition names read back from pg_catalog before they are interpolated
 * into a DROP TABLE statement.
 */
function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
}

/**
 * Validate the parent table name for dropOldPartitions.
 */
function validateParentTable(name: string): { valid: boolean; reason?: string } {
  if (!name || name.trim() === '') {
    return { valid: false, reason: 'parentTable is required but was not provided.' }
  }
  if (!isSafeIdentifier(name.trim())) {
    return { valid: false, reason: 'parentTable must be a valid SQL identifier.' }
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
     
    S3Client = s3Mod.S3Client
     
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

   
  const client = new S3Client({ region })

   
  const upload = new Upload({
    client,
    params: { Bucket: target.bucket, Key: target.key, Body: readable },
    partSize: 5 * 1024 * 1024, // 5 MiB parts
    queueSize: 4,
  })

   
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
  const normalizedDatabaseUrl = databaseUrl.trim()
  const normalizedOutputPath = outputPath.trim()

  const urlCheck = validateDatabaseUrl(normalizedDatabaseUrl)
  if (!urlCheck.valid) {
    logger.warn('backupDatabase validation failed', undefined, { reason: urlCheck.reason })
    return { success: false, message: urlCheck.reason! }
  }

  logger.info('backupDatabase started', undefined, {
    databaseUrl: redactDatabaseUrl(normalizedDatabaseUrl),
    target: s3Target ? `s3://${s3Target.bucket}/${s3Target.key}` : normalizedOutputPath,
  })

  if (!s3Target) {
    const pathCheck = validatePath(normalizedOutputPath, 'Output')
    if (!pathCheck.valid) {
      logger.warn('backupDatabase validation failed', undefined, { reason: pathCheck.reason })
      return { success: false, message: pathCheck.reason! }
    }
  } else {
    const bucketCheck = validatePath(s3Target.bucket, 'S3 bucket')
    if (!bucketCheck.valid) {
      return { success: false, message: bucketCheck.reason! }
    }
    const keyCheck = validatePath(s3Target.key, 'S3 key')
    if (!keyCheck.valid) {
      return { success: false, message: keyCheck.reason! }
    }
  }

  try {
    if (s3Target) {
      // ── S3 streaming path ────────────────────────────────────────────────
      // Spawn pg_dump writing to stdout, pipe directly to S3 upload.
      const args = ['--format=custom', '--no-password', normalizedDatabaseUrl]
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
        const errorDetail = stderrOutput || `pg_dump exited with code ${exitCode}`
        logger.error('backupDatabase failed', undefined, { error: errorDetail })
        return {
          success: false,
          message: 'Backup failed',
          error: errorDetail,
        }
      }

      logger.info('backupDatabase succeeded', undefined, {
        target: `s3://${s3Target.bucket}/${s3Target.key}`,
      })
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
        `--file=${normalizedOutputPath}`,
        normalizedDatabaseUrl,
      ]

      await execFileAsync('pg_dump', args)

      logger.info('backupDatabase succeeded', undefined, { target: normalizedOutputPath })
      return {
        success: true,
        message: `Backup successfully written to ${normalizedOutputPath}`,
      }
    }
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string }
    const errorMsg =
      err.stderr?.trim() ||
      err.message ||
      'Unknown error occurred during pg_dump'
    logger.error('backupDatabase failed', undefined, { error: errorMsg })
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
  const normalizedDatabaseUrl = databaseUrl.trim()
  const normalizedInputPath = inputPath.trim()

  const urlCheck = validateDatabaseUrl(normalizedDatabaseUrl)
  if (!urlCheck.valid) {
    logger.warn('restoreDatabase validation failed', undefined, { reason: urlCheck.reason })
    return { success: false, message: urlCheck.reason! }
  }

  logger.info('restoreDatabase started', undefined, {
    databaseUrl: redactDatabaseUrl(normalizedDatabaseUrl),
    source: s3Source ? `s3://${s3Source.bucket}/${s3Source.key}` : normalizedInputPath,
  })

  if (!s3Source) {
    const pathCheck = validatePath(normalizedInputPath, 'Input')
    if (!pathCheck.valid) {
      logger.warn('restoreDatabase validation failed', undefined, { reason: pathCheck.reason })
      return { success: false, message: pathCheck.reason! }
    }
  } else {
    const bucketCheck = validatePath(s3Source.bucket, 'S3 bucket')
    if (!bucketCheck.valid) {
      return { success: false, message: bucketCheck.reason! }
    }
    const keyCheck = validatePath(s3Source.key, 'S3 key')
    if (!keyCheck.valid) {
      return { success: false, message: keyCheck.reason! }
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
         
        S3Client = s3Mod.S3Client
         
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

       
      const client = new S3Client({ region })
       
      const response = await client.send(
         
        new GetObjectCommand({ Bucket: s3Source.bucket, Key: s3Source.key }),
      ) as { Body?: Readable }

      if (!response.Body) {
        const errorDetail = `S3 object s3://${s3Source.bucket}/${s3Source.key} returned an empty body`
        logger.error('restoreDatabase failed', undefined, { error: errorDetail })
        return {
          success: false,
          message: 'Restore failed',
          error: errorDetail,
        }
      }

      // --clean drops objects before recreating; --no-owner skips ownership
      // restoration so the dump is portable across environments.
      const args = [
        '--clean',
        '--no-owner',
        '--no-password',
        `--dbname=${normalizedDatabaseUrl}`,
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
        const errorDetail = stderrOutput || `pg_restore exited with code ${exitCode}`
        logger.error('restoreDatabase failed', undefined, { error: errorDetail })
        return {
          success: false,
          message: 'Restore failed',
          error: errorDetail,
        }
      }

      logger.info('restoreDatabase succeeded', undefined, {
        source: `s3://${s3Source.bucket}/${s3Source.key}`,
      })
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
        `--dbname=${normalizedDatabaseUrl}`,
        normalizedInputPath,
      ]

      await execFileAsync('pg_restore', args)

      logger.info('restoreDatabase succeeded', undefined, { source: normalizedInputPath })
      return {
        success: true,
        message: `Restore successfully completed from ${normalizedInputPath}`,
      }
    }
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string }
    const errorMsg =
      err.stderr?.trim() ||
      err.message ||
      'Unknown error occurred during pg_restore'
    logger.error('restoreDatabase failed', undefined, { error: errorMsg })
    return { success: false, message: 'Restore failed', error: errorMsg }
  }
}

// ── dropOldPartitions ─────────────────────────────────────────────────────────

/**
 * Retention policy: Detach and drop old partitions for a given partitioned table.
 * Defaults to a dry run.
 * 
 * @param pool           PostgreSQL pg.Pool instance
 * @param parentTable    Name of the parent partitioned table (e.g. 'contract_events')
 * @param olderThanDays  Drop partitions containing data strictly older than this many days
 * @param dryRun         If true, only returns what would be dropped (default: true)
 */
export async function dropOldPartitions(
  pool: import('pg').Pool,
  parentTable: string,
  olderThanDays: number,
  dryRun = true
): Promise<{ droppedPartitions: string[]; message: string }> {
  if (!parentTable || parentTable.trim() === '') {
    return { droppedPartitions: [], message: 'parentTable is required but was not provided.' }
  }
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    return { droppedPartitions: [], message: 'olderThanDays must be a non-negative number.' }
  }

  const query = `
    SELECT
      c.relname AS partition_name,
      pg_get_expr(c.relpartbound, c.oid) AS partition_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = $1
  `;
  
  let res: import('pg').QueryResult
  try {
    res = await pool.query(query, [parentTable])
  } catch (err: unknown) {
    const dbErr = err as { message?: string }
    return {
      droppedPartitions: [],
      message: `Failed to query partitions for ${parentTable}: ${dbErr.message || 'unknown error'}`,
    }
  }

  const droppedPartitions: string[] = [];
  const skippedUnsafeNames: string[] = [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  
  for (const row of res.rows) {
    const pName = row.partition_name;
    const pBound = row.partition_bound;
    
    if (!pBound || pBound === 'DEFAULT') continue;
    
    // Bounds typically look like: FOR VALUES FROM ('2023-01-01 00:00:00+00') TO ('2023-02-01 00:00:00+00')
    // Note: literal parentheses in pg_get_expr output — no backslash escaping needed.
    const toMatch = pBound.match(/TO \('([^']+)'\)/);
    if (toMatch && toMatch[1]) {
      const toDate = new Date(toMatch[1]);
      if (toDate < cutoffDate) {
        // Defense-in-depth: pName comes from pg_catalog, not raw user input,
        // but we still refuse to interpolate anything that isn't a plain
        // SQL identifier before it reaches a DROP TABLE statement.
        if (!isSafeIdentifier(pName)) {
          skippedUnsafeNames.push(pName)
          continue
        }
        if (!dryRun) {
          // Explicitly require admin role or let it fail if insufficient perms.
          await pool.query(`DROP TABLE IF EXISTS ${pName}`);
        }
        droppedPartitions.push(pName);
      }
    }
  }

  if (skippedUnsafeNames.length > 0) {
    logger.warn('dropOldPartitions skipped partitions with unsafe names', undefined, {
      parentTable,
      skippedUnsafeNames,
    })
  }
  
  if (dryRun) {
    const message = `[DRY RUN] Would drop ${droppedPartitions.length} old partitions for ${parentTable}`
    logger.info('dropOldPartitions completed', undefined, { parentTable, dryRun, count: droppedPartitions.length })
    return {
      success: true,
      droppedPartitions,
      message
    };
  }
  
  const message = `Dropped ${droppedPartitions.length} old partitions for ${parentTable}`
  logger.info('dropOldPartitions completed', undefined, { parentTable, dryRun, count: droppedPartitions.length })
  return {
    success: true,
    droppedPartitions,
    message
  };
}
