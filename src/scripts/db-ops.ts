import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface DbOperationResult {
  success: boolean
  message: string
  error?: string
}

/**
 * Creates a custom-format PostgreSQL backup using pg_dump.
 * @param databaseUrl The connection string (e.g., postgres://user:pass@host:5432/db)
 * @param outputPath The file path to save the dump (e.g., ./backup.dump)
 */
export async function backupDatabase(
  databaseUrl: string,
  outputPath: string
): Promise<DbOperationResult> {
  if (!databaseUrl) {
    return {
      success: false,
      message: 'DATABASE_URL is required but was not provided.',
    }
  }

  // Using custom format (-F c) which is most reliable for pg_restore
  const command = `pg_dump -F c -f "${outputPath}" "${databaseUrl}"`

  try {
    await execAsync(command)
    return {
      success: true,
      message: `Backup successfully written to ${outputPath}`,
    }
  } catch (error: any) {
    const errorMsg =
      error.stderr || error.message || 'Unknown error occurred during pg_dump'
    return { success: false, message: 'Backup failed', error: errorMsg }
  }
}

/**
 * Restores a custom-format PostgreSQL backup using pg_restore.
 * WARNING: This uses --clean to drop existing objects before recreating them.
 * @param databaseUrl The connection string
 * @param inputPath The file path of the dump to restore
 */
export async function restoreDatabase(
  databaseUrl: string,
  inputPath: string
): Promise<DbOperationResult> {
  if (!databaseUrl) {
    return {
      success: false,
      message: 'DATABASE_URL is required but was not provided.',
    }
  }

  // --clean drops database objects before recreating them.
  // --no-owner skips restoring object ownership, useful when restoring to a different environment.
  const command = `pg_restore --clean --no-owner -d "${databaseUrl}" "${inputPath}"`

  try {
    await execAsync(command)
    return {
      success: true,
      message: `Restore successfully completed from ${inputPath}`,
    }
  } catch (error: any) {
    // pg_restore often throws warnings to stderr even on success, but execAsync will throw if exit code != 0
    const errorMsg =
      error.stderr ||
      error.message ||
      'Unknown error occurred during pg_restore'
    return { success: false, message: 'Restore failed', error: errorMsg }
  }
}
