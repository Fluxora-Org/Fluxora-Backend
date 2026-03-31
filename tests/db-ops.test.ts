import { jest } from '@jest/globals'

// 1. Intercept the module BEFORE it gets imported
jest.unstable_mockModule('child_process', () => ({
  exec: jest.fn((cmd: any, callback: any) => {
    // If the test passes an error string, simulate a failure
    if (cmd.includes('fail-test')) {
      callback(new Error('simulated error'), { stdout: '', stderr: '' })
    } else {
      callback(null, { stdout: '', stderr: '' })
    }
  }),
}))

// 2. Dynamically import our code AFTER the mock is in place
const { backupDatabase, restoreDatabase } =
  await import('../src/scripts/db-ops.js')
const child_process = await import('child_process')

describe('Database Backup and Restore Operations', () => {
  const mockDbUrl = 'postgres://user:pass@localhost:5432/fluxora'
  const mockPath = './test-backup.dump'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('backupDatabase', () => {
    it('should successfully execute pg_dump', async () => {
      const result = await backupDatabase(mockDbUrl, mockPath)
      expect(result.success).toBe(true)
      expect(result.message).toContain(mockPath)
      expect(child_process.exec).toHaveBeenCalled()
    })

    it('should fail cleanly if DATABASE_URL is missing', async () => {
      const result = await backupDatabase('', mockPath)
      expect(result.success).toBe(false)
      expect(result.message).toContain('DATABASE_URL is required')
    })

    it('should handle pg_dump execution errors', async () => {
      // Pass our special trigger string to simulate a failure
      const result = await backupDatabase('fail-test', mockPath)
      expect(result.success).toBe(false)
      expect(result.message).toBe('Backup failed')
    })
  })

  describe('restoreDatabase', () => {
    it('should successfully execute pg_restore', async () => {
      const result = await restoreDatabase(mockDbUrl, mockPath)
      expect(result.success).toBe(true)
      expect(result.message).toContain(mockPath)
      expect(child_process.exec).toHaveBeenCalled()
    })

    it('should fail cleanly if DATABASE_URL is missing', async () => {
      const result = await restoreDatabase('', mockPath)
      expect(result.success).toBe(false)
      expect(result.message).toContain('DATABASE_URL is required')
    })

    it('should handle pg_restore execution errors', async () => {
      const result = await restoreDatabase('fail-test', mockPath)
      expect(result.success).toBe(false)
      expect(result.message).toBe('Restore failed')
    })
  })
})
