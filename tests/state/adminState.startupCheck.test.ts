import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkAdminStatePersistence, _resetForTest } from '../../src/state/adminState.js';

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock node:fs so mkdirSync can be made to throw on demand
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: { ...actual },
  };
});

import { logger } from '../../src/lib/logger.js';

describe('checkAdminStatePersistence', () => {
  let originalAdminStateFile: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalAdminStateFile = process.env.ADMIN_STATE_FILE;
    tempDir = join(
      tmpdir(),
      `fluxora-probe-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    vi.clearAllMocks();
    _resetForTest();
  });

  afterEach(() => {
    _resetForTest();
    if (originalAdminStateFile !== undefined) {
      process.env.ADMIN_STATE_FILE = originalAdminStateFile;
    } else {
      delete process.env.ADMIN_STATE_FILE;
    }
    // Cleanup temp directory if it exists
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // no-op
    }
  });

  it('returns true and does not log a warning when the path is writable', async () => {
    const adminStateFile = join(tempDir, 'admin-state.json');
    process.env.ADMIN_STATE_FILE = adminStateFile;

    const result = await checkAdminStatePersistence();

    expect(result).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('cleans up the probe file after a successful write check', async () => {
    const adminStateFile = join(tempDir, 'admin-state.json');
    process.env.ADMIN_STATE_FILE = adminStateFile;

    await checkAdminStatePersistence();

    const probePath = join(tempDir, '.fluxora-admin-state.probe');
    expect(fs.existsSync(probePath)).toBe(false);
  });

  it('returns false and logs a warning with the correct event when path is not writable', async () => {
    // Create a read-only directory to simulate a non-writable filesystem
    const readOnlyDir = join(tempDir, 'readonly');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    fs.chmodSync(readOnlyDir, 0o444);

    const adminStateFile = join(readOnlyDir, 'subdir', 'admin-state.json');
    process.env.ADMIN_STATE_FILE = adminStateFile;

    const result = await checkAdminStatePersistence();

    // Restore permissions for cleanup
    fs.chmodSync(readOnlyDir, 0o755);

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    const [, , meta] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(meta).toMatchObject({ event: 'admin_state_file_not_writable' });
  });

  it('warning log does not expose the file path', async () => {
    // Create a read-only directory
    const readOnlyDir = join(tempDir, 'sensitive-internal-path');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    fs.chmodSync(readOnlyDir, 0o444);

    const adminStateFile = join(readOnlyDir, 'subdir', 'admin-state.json');
    process.env.ADMIN_STATE_FILE = adminStateFile;

    await checkAdminStatePersistence();

    // Restore permissions for cleanup
    fs.chmodSync(readOnlyDir, 0o755);

    const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const allArgs = JSON.stringify(calls);
    expect(allArgs).not.toContain('sensitive-internal-path');
  });

  it('server continues to operate (no throw) when path is not writable', async () => {
    const readOnlyDir = join(tempDir, 'no-throw-test');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    fs.chmodSync(readOnlyDir, 0o444);

    process.env.ADMIN_STATE_FILE = join(readOnlyDir, 'subdir', 'admin-state.json');

    await expect(checkAdminStatePersistence()).resolves.not.toThrow();

    fs.chmodSync(readOnlyDir, 0o755);
  });

  it('respects a custom ADMIN_STATE_FILE environment variable', async () => {
    const customDir = join(tempDir, 'custom');
    const customFile = join(customDir, 'custom-admin-state.json');
    process.env.ADMIN_STATE_FILE = customFile;

    const result = await checkAdminStatePersistence();

    expect(result).toBe(true);
    // The custom directory should have been created
    expect(fs.existsSync(customDir)).toBe(true);
  });
});
