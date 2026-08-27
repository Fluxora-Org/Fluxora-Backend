const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REQUIRED_MANAGER = 'pnpm';
const FOREIGN_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

function getRequiredPnpmVersion(packageManager) {
  const match = /^pnpm@([^+\s]+)(?:\+\S+)?$/.exec(packageManager || '');

  if (!match) {
    throw new Error('package.json must declare pnpm in its packageManager field.');
  }

  return match[1];
}

function getUserAgentPnpmVersion(userAgent) {
  const managerToken = (userAgent || '').trim().split(/\s+/, 1)[0];
  const match = /^pnpm\/(.+)$/.exec(managerToken);
  return match ? match[1] : null;
}

function findForeignLockfiles(rootDir) {
  return FOREIGN_LOCKFILES.filter((lockfile) => existsSync(join(rootDir, lockfile)));
}

function readPackageManager(rootDir) {
  const packageJsonPath = join(rootDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.packageManager;
}

function remediation(requiredVersion) {
  return [
    `Fluxora uses pnpm ${requiredVersion} exclusively.`,
    'Enable the pinned version with:',
    '  corepack enable',
    `  corepack prepare pnpm@${requiredVersion} --activate`,
    'Then run: pnpm install --frozen-lockfile',
  ].join('\n');
}

function validatePackageManager(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const packageManager = options.packageManager ?? readPackageManager(rootDir);
  const requiredVersion = getRequiredPnpmVersion(packageManager);
  const actualVersion = getUserAgentPnpmVersion(
    options.userAgent ?? process.env.npm_config_user_agent
  );

  if (!actualVersion) {
    throw new Error(remediation(requiredVersion));
  }

  if (actualVersion !== requiredVersion) {
    throw new Error(
      `pnpm ${requiredVersion} is required, but pnpm ${actualVersion} was detected.\n${remediation(
        requiredVersion
      )}`
    );
  }

  const foreignLockfiles = findForeignLockfiles(rootDir);
  if (foreignLockfiles.length > 0) {
    throw new Error(
      `Remove ${foreignLockfiles.join(', ')}. pnpm-lock.yaml is the only supported lockfile.`
    );
  }

  return { version: requiredVersion };
}

function runGuard(options = {}) {
  const logError = options.logError || console.error;

  try {
    validatePackageManager(options);
    return 0;
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runGuard();
}

module.exports = {
  FOREIGN_LOCKFILES,
  REQUIRED_MANAGER,
  findForeignLockfiles,
  getRequiredPnpmVersion,
  getUserAgentPnpmVersion,
  runGuard,
  validatePackageManager,
};
