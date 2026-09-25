import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface GuardOptions {
  userAgent?: string;
  packageManager?: string;
  rootDir?: string;
  logError?: (message: string) => void;
}

interface GuardModule {
  REQUIRED_MANAGER: string;
  FOREIGN_LOCKFILES: string[];
  findForeignLockfiles: (rootDir: string) => string[];
  getRequiredPnpmVersion: (packageManager: string) => string;
  getUserAgentPnpmVersion: (userAgent?: string) => string | null;
  validatePackageManager: (options?: GuardOptions) => { version: string };
  runGuard: (options?: GuardOptions) => number;
}

const guard = require('../../scripts/check-package-manager.js') as GuardModule;
const temporaryDirectories: string[] = [];

function emptyTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fluxora-package-manager-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('package-manager guard', () => {
  const packageManager =
    'pnpm@9.15.9+sha512.68046141893c66fad01c079231128e9afb89ef87e2691d69e4d40eee228988295fd4682181bae55b58418c3a253bde65a505ec7c5f9403ece5cc3cd37dcf2531';

  it('extracts the pinned pnpm version without its integrity suffix', () => {
    expect(guard.REQUIRED_MANAGER).toBe('pnpm');
    expect(guard.getRequiredPnpmVersion(packageManager)).toBe('9.15.9');
  });

  it('rejects a missing or malformed packageManager declaration', () => {
    expect(() => guard.getRequiredPnpmVersion('')).toThrow(/must declare pnpm/i);
    expect(() => guard.getRequiredPnpmVersion('npm@10.9.0')).toThrow(/must declare pnpm/i);
  });

  it('extracts pnpm only when it is the invoking package manager', () => {
    expect(guard.getUserAgentPnpmVersion('pnpm/9.15.9 npm/? node/v20.19.0 linux x64')).toBe(
      '9.15.9'
    );
    expect(guard.getUserAgentPnpmVersion('npm/10.9.2 node/v20.19.0 win32 x64')).toBeNull();
    expect(guard.getUserAgentPnpmVersion(undefined)).toBeNull();
  });

  it('accepts the pinned pnpm version when no foreign lockfile exists', () => {
    const rootDir = emptyTemporaryDirectory();

    expect(
      guard.validatePackageManager({
        packageManager,
        rootDir,
        userAgent: 'pnpm/9.15.9 npm/? node/v20.19.0 linux x64',
      })
    ).toEqual({ version: '9.15.9' });
  });

  it.each([
    ['npm', 'npm/10.9.2 node/v20.19.0 win32 x64'],
    ['yarn', 'yarn/4.9.2 npm/? node/v20.19.0 linux x64'],
    ['missing user agent', ''],
  ])('rejects the unsupported %s invocation with remediation', (_label, userAgent) => {
    const rootDir = emptyTemporaryDirectory();

    expect(() => guard.validatePackageManager({ packageManager, rootDir, userAgent })).toThrow(
      /corepack prepare pnpm@9\.15\.9 --activate/i
    );
  });

  it('rejects a different pnpm version', () => {
    const rootDir = emptyTemporaryDirectory();

    expect(() =>
      guard.validatePackageManager({
        packageManager,
        rootDir,
        userAgent: 'pnpm/11.19.0 npm/? node/v22.20.0 win32 x64',
      })
    ).toThrow(/pnpm 9\.15\.9 is required.*pnpm 11\.19\.0 was detected/i);
  });

  it('finds lockfiles from unsupported package managers', () => {
    const rootDir = emptyTemporaryDirectory();
    writeFileSync(join(rootDir, 'package-lock.json'), '{}\n');
    writeFileSync(join(rootDir, 'yarn.lock'), '');

    expect(guard.findForeignLockfiles(rootDir)).toEqual(['package-lock.json', 'yarn.lock']);
  });

  it('rejects a foreign lockfile even when pnpm is correct', () => {
    const rootDir = emptyTemporaryDirectory();
    writeFileSync(join(rootDir, 'package-lock.json'), '{}\n');

    expect(() =>
      guard.validatePackageManager({
        packageManager,
        rootDir,
        userAgent: 'pnpm/9.15.9 npm/? node/v20.19.0 linux x64',
      })
    ).toThrow(/remove package-lock\.json/i);
  });

  it('returns a nonzero status and prints a concise error on failure', () => {
    const rootDir = emptyTemporaryDirectory();
    const logError = vi.fn<(message: string) => void>();

    expect(
      guard.runGuard({
        logError,
        packageManager,
        rootDir,
        userAgent: 'npm/10.9.2 node/v20.19.0 win32 x64',
      })
    ).toBe(1);
    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0][0]).toMatch(/Fluxora uses pnpm 9\.15\.9/i);
  });

  it('returns zero without logging when validation succeeds', () => {
    const rootDir = emptyTemporaryDirectory();
    const logError = vi.fn<(message: string) => void>();

    expect(
      guard.runGuard({
        logError,
        packageManager,
        rootDir,
        userAgent: 'pnpm/9.15.9 npm/? node/v20.19.0 linux x64',
      })
    ).toBe(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it('uses package.json, the repository root, and the process user agent by default', () => {
    const previousUserAgent = process.env.npm_config_user_agent;
    process.env.npm_config_user_agent = 'pnpm/9.15.9 npm/? node/v20.19.0 win32 x64';

    try {
      expect(guard.validatePackageManager()).toEqual({ version: '9.15.9' });
      expect(guard.runGuard()).toBe(0);
    } finally {
      if (previousUserAgent === undefined) {
        delete process.env.npm_config_user_agent;
      } else {
        process.env.npm_config_user_agent = previousUserAgent;
      }
    }
  });
});
