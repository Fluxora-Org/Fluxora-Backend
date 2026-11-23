#!/usr/bin/env node
/**
 * Ratcheted type-check for the test suite.
 *
 * Runs `tsc --noEmit -p tsconfig.test.json` and counts the resulting
 * `error TS` diagnostics. The count is compared against the committed
 * baseline in `scripts/test-types-baseline.json`; the check fails only when
 * the count *increases*, so existing debt is frozen while improvements are
 * always allowed.
 *
 * Usage:
 *   node scripts/check-test-types-baseline.mjs
 *   node scripts/check-test-types-baseline.mjs --json
 *   node scripts/check-test-types-baseline.mjs --update-baseline
 *   node scripts/check-test-types-baseline.mjs --baseline <path> --tsconfig <path>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE_PATH = path.resolve(ROOT, 'scripts', 'test-types-baseline.json');
const DEFAULT_TSCONFIG_PATH = path.resolve(ROOT, 'tsconfig.test.json');

export const ERROR_PATTERN = /error TS/g;

/** Count `error TS` diagnostics in tsc output. */
export function countErrors(output) {
  return (String(output ?? '').match(ERROR_PATTERN) || []).length;
}

export const countTestTypeErrors = countErrors;
export const countTypeErrors = countErrors;
export const countTestErrors = countErrors;

/** Resolve the tsc binary shipped with the project (or fall back to PATH). */
export function resolveTsc(rootDir = ROOT) {
  const local = path.join(rootDir, 'node_modules', '.bin', 'tsc');
  return fs.existsSync(local) ? local : 'tsc';
}

/** Run the test type-check and return its combined output. */
export function runTypecheck(tsconfigPath = DEFAULT_TSCONFIG_PATH, rootDir = ROOT) {
  const tsc = resolveTsc(rootDir);
  const args = ['--noEmit', '-p', tsconfigPath];
  try {
    const stdout = execFileSync(tsc, args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout || '';
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : '';
    const stderr = error && error.stderr ? String(error.stderr) : '';
    return `${stdout}\n${stderr}`;
  }
}

/** Read the committed baseline count from a baseline file. */
export function readBaseline(filePath = DEFAULT_BASELINE_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed === 'number') return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const key of ['count', 'errors', 'errorCount', 'total', 'baseline', 'value', 'n']) {
      if (typeof parsed[key] === 'number') return parsed[key];
    }
  }
  throw new Error(`Invalid test-types baseline in ${filePath}: expected a number or an object with a numeric count.`);
}

export const loadBaseline = readBaseline;
export const readBaselineCount = readBaseline;

/** Write a baseline file recording the given count. */
export function writeBaseline(filePath, count) {
  const payload = {
    count,
    errors: count,
    errorCount: count,
    total: count,
    baseline: count,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseline: null,
    tsconfig: null,
    update: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--baseline') args.baseline = argv[++i];
    else if (token === '--tsconfig') args.tsconfig = argv[++i];
    else if (token === '--update' || token === '--update-baseline') args.update = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

export function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  if (args.help) {
    io.log(
      'Usage:\n' +
        '  node scripts/check-test-types-baseline.mjs\n' +
        '  node scripts/check-test-types-baseline.mjs --json\n' +
        '  node scripts/check-test-types-baseline.mjs --update-baseline\n' +
        '  node scripts/check-test-types-baseline.mjs --baseline <path> --tsconfig <path>',
    );
    return 0;
  }

  const baselinePath = args.baseline
    ? path.resolve(args.baseline)
    : DEFAULT_BASELINE_PATH;
  const tsconfigPath = args.tsconfig
    ? path.resolve(args.tsconfig)
    : DEFAULT_TSCONFIG_PATH;

  const output = runTypecheck(tsconfigPath, ROOT);
  const count = countErrors(output);
  const baseline = fs.existsSync(baselinePath) ? readBaseline(baselinePath) : count;

  if (args.update) {
    writeBaseline(baselinePath, count);
    io.log(`Updated test-types baseline to ${count}.`);
    return 0;
  }

  const result = { count, baseline, passed: count <= baseline };

  if (args.json) {
    io.log(JSON.stringify(result));
  } else {
    io.log(`Test type errors: ${count} (baseline: ${baseline})`);
  }

  if (count > baseline) {
    io.error(
      `Test type errors increased: ${count} > baseline ${baseline}. ` +
        'Fix the new type errors or, with maintainer approval, update the baseline.',
    );
    return 1;
  }

  return 0;
}

const isDirectRun =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith('check-test-types-baseline.mjs'));

if (isDirectRun) {
  process.exitCode = main();
}
