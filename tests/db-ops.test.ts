import { backupDatabase, restoreDatabase } from '../src/scripts/db-ops'
import * as child_process from 'child_process'

// Mock the child_process to avoid actually running pg_dump/pg_restore during tests
jest.mock('child_process', () => ({
  exec: jest.fn(),
}))

describe('Database Backup and Restore Operations', () => {
  const mockDbUrl = 'postgres://user:pass@localhost:5432/fluxora'
  const mockPath = './test-backup.dump'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('backupDatabase', () => {
    it('should successfully execute pg_dump', async () => {
      ;(child_process.exec as unknown as jest.Mock).mockImplementation(
        (cmd, callback) => {
          callback(null, { stdout: '', stderr: '' })
        }
      )

      const result = await backupDatabase(mockDbUrl, mockPath)

      expect(result.success).toBe(true)
      expect(result.message).toContain(mockPath)
      expect(child_process.exec).toHaveBeenCalledWith(
        expect.stringContaining('pg_dump -F c'),
        expect.any(Function)
      )
    })

    it('should fail cleanly if DATABASE_URL is missing', async () => {
      const result = await backupDatabase('', mockPath)
      expect(result.success).toBe(false)
      expect(result.message).toContain('DATABASE_URL is required')
      expect(child_process.exec).not.toHaveBeenCalled()
    })

    it('should handle pg_dump execution errors', async () => {
      ;(child_process.exec as unknown as jest.Mock).mockImplementation(
        (cmd, callback) => {
          callback(new Error('FATAL: password authentication failed'), {
            stdout: '',
            stderr: 'FATAL: password authentication failed',
          })
        }
      )

      const result = await backupDatabase(mockDbUrl, mockPath)

      expect(result.success).toBe(false)
      expect(result.message).toBe('Backup failed')
      expect(result.error).toContain('password authentication failed')
    })
  })

  describe('restoreDatabase', () => {
    it('should successfully execute pg_restore', async () => {
      ;(child_process.exec as unknown as jest.Mock).mockImplementation(
        (cmd, callback) => {
          callback(null, { stdout: '', stderr: '' })
        }
      )

      const result = await restoreDatabase(mockDbUrl, mockPath)

      expect(result.success).toBe(true)
      expect(result.message).toContain(mockPath)
      expect(child_process.exec).toHaveBeenCalledWith(
        expect.stringContaining('pg_restore --clean --no-owner'),
        expect.any(Function)
      )
    })

    it('should fail cleanly if DATABASE_URL is missing', async () => {
      const result = await restoreDatabase('', mockPath)
      expect(result.success).toBe(false)
      expect(result.message).toContain('DATABASE_URL is required')
      expect(child_process.exec).not.toHaveBeenCalled()
    })

    it('should handle pg_restore execution errors', async () => {
      ;(child_process.exec as unknown as jest.Mock).mockImplementation(
        (cmd, callback) => {
          callback(
            new Error(
              'pg_restore: error: input file does not appear to be a valid archive'
            ),
            { stdout: '', stderr: '' }
          )
        }
      )

      const result = await restoreDatabase(mockDbUrl, mockPath)

      expect(result.success).toBe(false)
      expect(result.message).toBe('Restore failed')
      expect(result.error).toContain('valid archive')
    })
  })
})
