/**
 * @file tests/sdk/sdk.versioning.test.ts
 *
 * SDK Versioning & Publication — Contract Tests
 * =============================================
 *
 * Asserts the guarantees behind "the generated SDKs are published and versioned
 * alongside the API":
 *
 *   1. `openapi.yaml` `info.version` is the single source of truth and both
 *      generated SDKs copy it verbatim (package.json / pyproject.toml /
 *      `__version__`).
 *   2. `scripts/check-sdk-version-sync.mjs` passes on the real tree, detects
 *      drift, and rejects a release tag that does not match the API version.
 *   3. `package.json` exposes the `check:sdk:version` script and CI runs it.
 *   4. `.github/workflows/publish-sdk.yml` is triggered by `v*` tags, verifies
 *      the version, and publishes both SDKs.
 *   5. `docs/sdk-publishing.md` documents the version relationship, the
 *      breaking-change policy, the tagged-release automation, and where
 *      consumers obtain each SDK.
 *
 * Closes: #1511
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const SYNC_SCRIPT = path.resolve(ROOT_DIR, 'scripts/check-sdk-version-sync.mjs');
const TS_PACKAGE = path.resolve(ROOT_DIR, 'sdk/typescript/package.json');
const PY_PROJECT = path.resolve(ROOT_DIR, 'sdk/python/pyproject.toml');
const PY_INIT = path.resolve(ROOT_DIR, 'sdk/python/fluxora/__init__.py');
const SPEC = path.resolve(ROOT_DIR, 'openapi.yaml');
const PUBLISH_WORKFLOW = path.resolve(ROOT_DIR, '.github/workflows/publish-sdk.yml');
const CI_WORKFLOW = path.resolve(ROOT_DIR, '.github/workflows/ci.yml');
const PUBLISH_DOC = path.resolve(ROOT_DIR, 'docs/sdk-publishing.md');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Extract `info.version` from the OpenAPI YAML document. */
function readSpecVersion(): string {
  const lines = fs.readFileSync(SPEC, 'utf8').split(/\r?\n/);
  let infoIndent = -1;
  let blockScalarIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (blockScalarIndent !== -1) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }
    if (infoIndent === -1) {
      if (/^info:\s*$/.test(trimmed)) infoIndent = indent;
      continue;
    }
    if (indent <= infoIndent) break;
    if (indent === infoIndent + 2 && /^[A-Za-z0-9_-]+:\s*[|>]/.test(trimmed)) {
      blockScalarIndent = indent;
      continue;
    }
    if (indent === infoIndent + 2) {
      const match = trimmed.match(/^version:\s*['"]?([^'"\s#]+)/);
      if (match) return match[1];
    }
  }
  throw new Error('openapi.yaml is missing info.version');
}

function readTsVersion(): string {
  return JSON.parse(fs.readFileSync(TS_PACKAGE, 'utf8')).version;
}

function firstMatch(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(label);
  return match[1];
}

function readPyProjectVersion(): string {
  return firstMatch(
    fs.readFileSync(PY_PROJECT, 'utf8'),
    /^\s*version\s*=\s*"([^"]+)"/m,
    'pyproject.toml is missing [project] version',
  );
}

function readPyInitVersion(): string {
  return firstMatch(
    fs.readFileSync(PY_INIT, 'utf8'),
    /^__version__\s*=\s*"([^"]+)"/m,
    'fluxora/__init__.py is missing __version__',
  );
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runSyncScript(extraArgs: string[] = []): RunResult {
  try {
    const stdout = execSync(
      `node "${SYNC_SCRIPT}" ${extraArgs.join(' ')}`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    };
  }
}

// Temp fixture roots created during the drift tests, cleaned up in afterAll.
const tempDirs: string[] = [];

function fixtureRoot(overrides: { ts?: string; py?: string; init?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-version-sync-'));
  tempDirs.push(dir);
  const version = readSpecVersion();

  fs.copyFileSync(SPEC, path.join(dir, 'openapi.yaml'));

  fs.mkdirSync(path.join(dir, 'sdk/typescript'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sdk/typescript/package.json'),
    JSON.stringify({ name: '@fluxora/sdk', version: overrides.ts ?? version }, null, 2),
  );

  fs.mkdirSync(path.join(dir, 'sdk/python/fluxora'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sdk/python/pyproject.toml'),
    `[project]\nname = "fluxora-sdk"\nversion = "${overrides.py ?? version}"\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'sdk/python/fluxora/__init__.py'),
    `__version__ = "${overrides.init ?? version}"\n`,
  );

  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 1. Version relationship — SDK version == API version
// =============================================================================

describe('SDK version tracks the API version', () => {
  const specVersion = readSpecVersion();

  it('openapi.yaml declares a semver api version', () => {
    expect(specVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('TypeScript package.json version equals openapi.yaml info.version', () => {
    expect(readTsVersion()).toBe(specVersion);
  });

  it('Python pyproject.toml version equals openapi.yaml info.version', () => {
    expect(readPyProjectVersion()).toBe(specVersion);
  });

  it('Python __version__ equals openapi.yaml info.version', () => {
    expect(readPyInitVersion()).toBe(specVersion);
  });

  it('all four version declarations agree', () => {
    expect(readTsVersion()).toBe(readPyProjectVersion());
    expect(readPyProjectVersion()).toBe(readPyInitVersion());
  });
});

// =============================================================================
// 2. Version-sync guard script
// =============================================================================

describe('scripts/check-sdk-version-sync.mjs', () => {
  it('exists and is executable via node', () => {
    expect(fs.existsSync(SYNC_SCRIPT)).toBe(true);
  });

  it('passes on the real repository tree', () => {
    const result = runSyncScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[SDK VERSION SYNC OK]');
  });

  it('accepts a release tag that matches the API version', () => {
    const result = runSyncScript([`--tag v${readSpecVersion()}`]);
    expect(result.status).toBe(0);
  });

  it('rejects a release tag that does not match the API version', () => {
    const result = runSyncScript(['--tag v999.999.999']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('[SDK VERSION SYNC FAILED]');
  });

  it('detects a TypeScript SDK version drift', () => {
    const dir = fixtureRoot({ ts: '999.999.999' });
    const result = runSyncScript([`--root ${dir}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sdk/typescript/package.json');
  });

  it('detects a Python pyproject.toml version drift', () => {
    const dir = fixtureRoot({ py: '999.999.999' });
    const result = runSyncScript([`--root ${dir}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sdk/python/pyproject.toml');
  });

  it('detects a Python __version__ drift', () => {
    const dir = fixtureRoot({ init: '999.999.999' });
    const result = runSyncScript([`--root ${dir}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sdk/python/fluxora/__init__.py');
  });

  it('passes when a fixture root has all versions in sync', () => {
    const dir = fixtureRoot();
    const result = runSyncScript([`--root ${dir}`]);
    expect(result.status).toBe(0);
  });

  it('fails when openapi.yaml is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-version-sync-empty-'));
    tempDirs.push(dir);
    const result = runSyncScript([`--root ${dir}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('openapi.yaml');
  });
});

// =============================================================================
// 3. CI wiring
// =============================================================================

describe('CI version-sync wiring', () => {
  it('package.json exposes check:sdk:version', () => {
    const scripts = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, 'package.json'), 'utf8')).scripts;
    expect(scripts['check:sdk:version']).toContain('scripts/check-sdk-version-sync.mjs');
  });

  it('package.json exposes the composite check:sdk gate', () => {
    const scripts = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, 'package.json'), 'utf8')).scripts;
    expect(scripts['check:sdk']).toContain('check:sdk:version');
  });

  it('ci.yml runs the version-sync check', () => {
    const ci = fs.readFileSync(CI_WORKFLOW, 'utf8');
    expect(ci).toContain('scripts/check-sdk-version-sync.mjs');
  });
});

// =============================================================================
// 4. Publication workflow
// =============================================================================

describe('Publish SDKs workflow', () => {
  let workflow: string;

  it('exists', () => {
    expect(fs.existsSync(PUBLISH_WORKFLOW)).toBe(true);
    workflow = fs.readFileSync(PUBLISH_WORKFLOW, 'utf8');
  });

  it('is triggered by version tags', () => {
    expect(workflow).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:/);
    expect(workflow).toContain("'v*'");
  });

  it('verifies SDK drift and the release tag before publishing', () => {
    expect(workflow).toContain('generate-sdk-ts.mjs --check');
    expect(workflow).toContain('generate-sdk-python.mjs --check');
    expect(workflow).toContain('check-sdk-version-sync.mjs --tag');
    expect(workflow).toContain('GITHUB_REF_NAME');
  });

  it('publishes the TypeScript SDK to npm using NPM_TOKEN', () => {
    expect(workflow).toContain('@fluxora/sdk');
    expect(workflow).toContain('NPM_TOKEN');
  });

  it('publishes the Python SDK to PyPI using PYPI_API_TOKEN', () => {
    expect(workflow).toContain('pypa/gh-action-pypi-publish');
    expect(workflow).toContain('PYPI_API_TOKEN');
    expect(workflow).toContain('sdk/python');
  });

  it('gates both publish jobs behind verification', () => {
    const needs = workflow.match(/needs:\s*\[verify\]/g) ?? [];
    expect(needs.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// 5. Documentation
// =============================================================================

describe('docs/sdk-publishing.md', () => {
  let doc: string;

  it('exists', () => {
    expect(fs.existsSync(PUBLISH_DOC)).toBe(true);
    doc = fs.readFileSync(PUBLISH_DOC, 'utf8');
  });

  it('documents the version relationship to the API', () => {
    expect(doc).toContain('openapi.yaml');
    expect(doc).toContain('info.version');
    expect(doc).toMatch(/single source of truth/i);
  });

  it('documents automated publication from a tagged release', () => {
    expect(doc).toContain('publish-sdk.yml');
    expect(doc).toMatch(/tag/i);
    expect(doc).toContain('NPM_TOKEN');
    expect(doc).toContain('PYPI_API_TOKEN');
  });

  it('documents how a breaking API change versions the SDK', () => {
    expect(doc).toMatch(/breaking/i);
    expect(doc).toContain('Semantic Versioning');
    expect(doc).toContain('major');
  });

  it('tells consumers where to obtain each SDK', () => {
    expect(doc).toContain('npmjs.com/package/@fluxora/sdk');
    expect(doc).toContain('pypi.org/project/fluxora-sdk');
    expect(doc).toContain('npm install @fluxora/sdk');
    expect(doc).toContain('pip install fluxora-sdk');
  });

  it('is linked from the API versioning doc', () => {
    const versioning = fs.readFileSync(path.resolve(ROOT_DIR, 'docs/api/versioning.md'), 'utf8');
    expect(versioning).toContain('sdk-publishing.md');
  });
});
