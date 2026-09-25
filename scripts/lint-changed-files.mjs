#!/usr/bin/env node

/**
 * Deterministic, fail-closed linting of changed TypeScript files.
 *
 * Rolls ESLint out to CI without blocking on the pre-existing full-tree
 * baseline. Only `.ts` files under `src/` and `tests/` that differ from the
 * configured base revision are linted, and ANY lint error OR warning in those
 * files fails the run. Untouched files are out of scope, so their existing
 * violations remain an accepted baseline while no new violation can slip in.
 *
 * There is deliberately no shell `|| echo` fallback: this script never spawns
 * a shell, uses ESLint's programmatic API directly, and exits non-zero when
 * any changed file carries a violation or when ESLint itself cannot run (which
 * includes a missing/unloadable ESLint configuration). See issue #1255.
 */

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

const ROOT = new URL('../', import.meta.url);
const pathname = (p) => new URL(p, ROOT).pathname;

/**
 * Base revision to diff against. For PRs we diff against the merged base
 * branch so the change set is exactly what this PR introduces. Locally the
 * documented rollout default is the shared `origin/main`.
 */
export function baseRef() {
  if (process.env.CI && process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }
  return process.env.LINT_BASE || 'upstream/main';
}

/**
 * List `.ts` source/test files changed relative to the base revision that are
 * in linting scope (`src/` and `tests/`). The `LINT_FILES` env override is
 * honoured for testing and ad-hoc single-file runs.
 */
export function changedTypeScriptFiles(base = baseRef()) {
  if (process.env.LINT_FILES) {
    return process.env.LINT_FILES.split('\n').filter((f) => f.endsWith('.ts'));
  }
  const diff = spawnSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`],
    { cwd: pathname('.'), encoding: 'utf8' },
  );
  if (diff.status !== 0) {
    throw new Error(`Unable to determine changed files against ${base}: ${diff.stderr.trim()}`);
  }
  return diff.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => f.startsWith('src/') || f.startsWith('tests/'));
}

/**
 * Lint the given files with ESLint's programmatic API. Any error or warning is
 * a failure. Resolves to `{ summary, results, formatter }`; throws if ESLint
 * cannot load its configuration, so a missing config is never masked.
 */
export async function lintFiles(files) {
  const eslint = new ESLint();
  const results = await eslint.lintFiles(files);
  const formatter = await eslint.loadFormatter('stylish');
  const totalErrors = results.reduce((n, r) => n + r.errorCount, 0);
  const totalWarnings = results.reduce((n, r) => n + r.warningCount, 0);
  const summary = `${totalErrors} error(s), ${totalWarnings} warning(s) across ${results.length} changed file(s).`;
  return { summary, results, formatter };
}

async function main() {
  const base = baseRef();
  const files = changedTypeScriptFiles(base);

  if (files.length === 0) {
    process.stdout.write(`Lint: no changed TypeScript files in scope (base=${base}). Nothing to do.\n`);
    process.exit(0);
  }

  process.stdout.write(`Lint: checking ${files.length} changed file(s) against ${base}.\n`);
  try {
    const { summary, results, formatter } = await lintFiles(files);
    const output = await formatter.format(results);
    const total = results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);
    process.stdout.write(output || `${summary}\n`);
    process.exit(total === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`Lint failed: ${error.message}\n`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
