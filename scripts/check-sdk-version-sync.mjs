#!/usr/bin/env node
/**
 * Version-sync guard for the generated client SDKs.
 *
 * `openapi.yaml` (`info.version`) is the single source of truth for the API
 * version. Both SDK generators copy that value into the SDK's own version
 * field, so the published SDK version must always equal the API version. This
 * script asserts that invariant across:
 *
 *   - `openapi.yaml`                          → `info.version`
 *   - `sdk/typescript/package.json`           → `version`
 *   - `sdk/python/pyproject.toml`             → `[project] version`
 *   - `sdk/python/fluxora/__init__.py`        → `__version__`
 *
 * Usage:
 *   node scripts/check-sdk-version-sync.mjs [--root <dir>] [--tag <tag>]
 *
 * Options:
 *   --root   Repository root to inspect (default: current working directory).
 *   --tag    Release tag to assert against (e.g. `v0.1.0`). A leading `v` is
 *            stripped before comparison. Used by the publish workflow so a tag
 *            can never ship an SDK whose version differs from the tag.
 *   --help   Print this usage block and exit 0.
 *
 * Exit codes:
 *   0  every version matches (prints `[SDK VERSION SYNC OK] v<version>`).
 *   1  a version is missing or does not match (prints
 *      `[SDK VERSION SYNC FAILED]` followed by the offending files).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'Usage: node scripts/check-sdk-version-sync.mjs [--root <dir>] [--tag <tag>]\n',
  );
  process.exit(0);
}

function readOption(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ROOT_DIR = path.resolve(readOption('--root', process.cwd()));
const RELEASE_TAG = readOption('--tag', null);

const SPEC_PATH = path.join(ROOT_DIR, 'openapi.yaml');
const TS_PACKAGE_PATH = path.join(ROOT_DIR, 'sdk/typescript/package.json');
const PY_PROJECT_PATH = path.join(ROOT_DIR, 'sdk/python/pyproject.toml');
const PY_INIT_PATH = path.join(ROOT_DIR, 'sdk/python/fluxora/__init__.py');

const failures = [];

function fail(message) {
  failures.push(message);
}

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing file: ${path.relative(ROOT_DIR, filePath)}`);
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Extract `info.version` from an OpenAPI YAML document.
 *
 * Only keys at the same indentation as `version` directly under the top-level
 * `info:` mapping are considered; block scalars (`description: |`) and nested
 * mappings are skipped so their contents can never be mistaken for the version.
 */
function readSpecVersion(specText) {
  const lines = specText.split(/\r?\n/);
  let infoIndent = -1;
  let blockScalarIndent = -1;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (blockScalarIndent !== -1) {
      // Still inside a `key: |` / `key: >` block scalar.
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }

    if (infoIndent === -1) {
      if (/^info:\s*$/.test(trimmed)) infoIndent = indent;
      continue;
    }

    // Left the `info:` mapping without finding a version.
    if (indent <= infoIndent) return null;

    if (indent === infoIndent + 2 && /^[A-Za-z0-9_-]+:\s*[|>]/.test(trimmed)) {
      blockScalarIndent = indent;
      continue;
    }

    if (indent === infoIndent + 2) {
      const match = trimmed.match(/^version:\s*['"]?([^'"\s#]+)/);
      if (match) return match[1];
    }
  }

  return null;
}

const specText = readFile(SPEC_PATH);
const specVersion = specText === null ? null : readSpecVersion(specText);

if (specText !== null && !specVersion) {
  fail('could not read `info.version` from openapi.yaml');
}

let tsVersion = null;
const tsText = readFile(TS_PACKAGE_PATH);
if (tsText !== null) {
  try {
    tsVersion = JSON.parse(tsText).version ?? null;
  } catch {
    fail('sdk/typescript/package.json is not valid JSON');
  }
  if (!tsVersion) fail('could not read `version` from sdk/typescript/package.json');
}

let pyProjectVersion = null;
const pyProjectText = readFile(PY_PROJECT_PATH);
if (pyProjectText !== null) {
  pyProjectVersion = pyProjectText.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  if (!pyProjectVersion) fail('could not read `version` from sdk/python/pyproject.toml');
}

let pyInitVersion = null;
const pyInitText = readFile(PY_INIT_PATH);
if (pyInitText !== null) {
  pyInitVersion = pyInitText.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  if (!pyInitVersion) fail('could not read `__version__` from sdk/python/fluxora/__init__.py');
}

if (specVersion) {
  const sources = [
    ['sdk/typescript/package.json', tsVersion],
    ['sdk/python/pyproject.toml', pyProjectVersion],
    ['sdk/python/fluxora/__init__.py', pyInitVersion],
  ];

  for (const [file, version] of sources) {
    if (version && version !== specVersion) {
      fail(
        `version drift: openapi.yaml info.version is ${specVersion} but ${file} declares ${version}`,
      );
    }
  }
}

if (RELEASE_TAG) {
  const tagVersion = RELEASE_TAG.replace(/^v/, '');
  if (!specVersion) {
    fail(`cannot verify release tag ${RELEASE_TAG} without an openapi.yaml version`);
  } else if (tagVersion !== specVersion) {
    fail(
      `release tag ${RELEASE_TAG} does not match openapi.yaml info.version ${specVersion}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write('[SDK VERSION SYNC FAILED]\n');
  for (const message of failures) process.stderr.write(`  - ${message}\n`);
  process.exit(1);
}

process.stdout.write(`[SDK VERSION SYNC OK] v${specVersion}\n`);
