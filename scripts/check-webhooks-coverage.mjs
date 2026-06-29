#!/usr/bin/env node

/**
 * Checks that src/webhooks/** meets minimum coverage thresholds.
 * Reads the v8 coverage JSON produced by vitest and computes aggregate
 * coverage for all non-test files under src/webhooks/.
 *
 * Usage:
 *   node scripts/check-webhooks-coverage.mjs [--json <path>]
 *
 * Defaults to reading coverage/coverage-final.json.
 */

import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_COVERAGE_JSON = resolve(ROOT, 'coverage/coverage-final.json');

const THRESHOLDS = {
  statements: 30,
  branches: 65,
  functions: 55,
};

const jsonPath = process.argv[2] === '--json' && process.argv[3]
  ? resolve(process.argv[3])
  : DEFAULT_COVERAGE_JSON;

let raw;
try {
  raw = readFileSync(jsonPath, 'utf-8');
} catch {
  console.error(
    `Coverage file not found at ${jsonPath}. Run "pnpm test:coverage" first.`,
  );
  process.exit(1);
}

const coverageMap = JSON.parse(raw);

const webhookFiles = Object.entries(coverageMap).filter(
  ([path]) =>
    path.includes('src/webhooks/') &&
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts'),
);

if (webhookFiles.length === 0) {
  console.error('No webhook source files found in coverage data.');
  process.exit(1);
}

const totals = { statements: [0, 0], branches: [0, 0], functions: [0, 0] };

for (const [, fileCoverage] of webhookFiles) {
  const { s: statements, b: branches, f: functions } = fileCoverage;

  for (const [, hit] of Object.entries(statements)) {
    totals.statements[0]++;
    if (hit > 0) totals.statements[1]++;
  }

  for (const [, hits] of Object.entries(branches)) {
    for (const hit of hits) {
      totals.branches[0]++;
      if (hit > 0) totals.branches[1]++;
    }
  }

  for (const [, hit] of Object.entries(functions)) {
    totals.functions[0]++;
    if (hit > 0) totals.functions[1]++;
  }
}

const coverage = {};
for (const key of ['statements', 'branches', 'functions']) {
  const [total, covered] = totals[key];
  coverage[key] = total > 0 ? (covered / total) * 100 : 100;
}

let allPassed = true;
const results = [];

for (const key of ['statements', 'branches', 'functions']) {
  const actual = coverage[key];
  const threshold = THRESHOLDS[key];
  const passed = actual >= threshold;
  if (!passed) allPassed = false;
  results.push({ key, actual, threshold, passed });
}

const formatPct = (v) => `${v.toFixed(2)}%`.padStart(7);

console.log(`\n  Webhooks coverage gate (src/webhooks/**):\n`);
for (const r of results) {
  const icon = r.passed ? '✓' : '✗';
  console.log(
    `    ${icon} ${r.key.padEnd(12)} ${formatPct(r.actual)}  (threshold: ${formatPct(r.threshold)})`,
  );
}

const maxNameLen = Math.max(...webhookFiles.map(([p]) => relative(ROOT, p).length));
const sorted = [...webhookFiles].sort(([a], [b]) => a.localeCompare(b));
console.log(`\n  Per-file detail:\n`);
for (const [path, fileCoverage] of sorted) {
  const { s: statements, b: branches, f: functions } = fileCoverage;
  const sTotal = Object.keys(statements).length;
  const sCovered = Object.values(statements).filter((h) => h > 0).length;
  const bTotal = Object.values(branches).reduce((a, hits) => a + hits.length, 0);
  const bCovered = Object.values(branches).reduce(
    (a, hits) => a + hits.filter((h) => h > 0).length,
    0,
  );
  const fTotal = Object.keys(functions).length;
  const fCovered = Object.values(functions).filter((h) => h > 0).length;
  const name = relative(ROOT, path);
  console.log(
    `    ${name.padEnd(maxNameLen)}  ` +
      `stmts ${(sTotal > 0 ? (sCovered / sTotal) * 100 : 100).toFixed(1).padStart(6)}%  ` +
      `branches ${(bTotal > 0 ? (bCovered / bTotal) * 100 : 100).toFixed(1).padStart(6)}%  ` +
      `funcs ${(fTotal > 0 ? (fCovered / fTotal) * 100 : 100).toFixed(1).padStart(6)}%`,
  );
}

console.log();

if (!allPassed) {
  console.error(
    '  ✗ Webhooks coverage below threshold — add tests before merging.\n',
  );
  process.exit(1);
}

console.log('  ✓ Webhooks coverage gate passed.\n');
