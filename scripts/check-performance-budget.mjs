#!/usr/bin/env node
/**
 * Performance budget gate for Fluxora hot endpoints.
 *
 * Reads k6/performance-budget.json and optionally evaluates a comparable
 * summary artifact (from k6 handleSummary). Exceeding any endpoint budget
 * exits non-zero so CI / local runs fail closed.
 *
 * Usage:
 *   node scripts/check-performance-budget.mjs
 *   node scripts/check-performance-budget.mjs --summary k6/results/performance-budget-summary.json
 *   node scripts/check-performance-budget.mjs --fixture-regression
 *   node scripts/check-performance-budget.mjs --json
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUDGET_PATH = resolve(ROOT, 'k6/performance-budget.json');

export function loadBudget(path = BUDGET_PATH) {
  const raw = readFileSync(path, 'utf-8');
  const budget = JSON.parse(raw);
  validateBudget(budget);
  return budget;
}

export function validateBudget(budget) {
  if (!budget || budget.version !== 1) {
    throw new Error('performance budget must declare version: 1');
  }
  if (!budget.reviewedAt || !budget.reviewedAgainst) {
    throw new Error('performance budget must record reviewedAt and reviewedAgainst');
  }
  if (!Array.isArray(budget.endpoints) || budget.endpoints.length === 0) {
    throw new Error('performance budget must list hot endpoints');
  }
  const required = ['health', 'streams_list', 'streams_get', 'streams_create'];
  const ids = new Set(budget.endpoints.map((e) => e.id));
  for (const id of required) {
    if (!ids.has(id)) {
      throw new Error(`performance budget missing hot endpoint: ${id}`);
    }
  }
  for (const endpoint of budget.endpoints) {
    if (!endpoint.budgets || (endpoint.budgets.p95 == null && endpoint.budgets.p99 == null)) {
      throw new Error(`endpoint ${endpoint.id} must declare p95 and/or p99 budgets`);
    }
    if (!endpoint.productionObservation) {
      throw new Error(`endpoint ${endpoint.id} must include productionObservation review`);
    }
  }
  return true;
}

/**
 * Evaluate a comparable summary against the budget.
 * @returns {{ passed: boolean, results: Array<object> }}
 */
export function evaluateSummary(budget, summary) {
  const byId = new Map((summary.endpoints || []).map((row) => [row.endpoint, row]));
  const results = [];

  for (const endpoint of budget.endpoints) {
    const row = byId.get(endpoint.id);
    if (!row) {
      results.push({
        endpoint: endpoint.id,
        passed: false,
        reason: 'missing from summary',
      });
      continue;
    }
    const failures = [];
    if (endpoint.budgets.p95 != null && row.p95_ms == null) {
      failures.push('p95 is missing from summary');
    } else if (endpoint.budgets.p95 != null && row.p95_ms > endpoint.budgets.p95) {
      failures.push(`p95 ${row.p95_ms}ms > budget ${endpoint.budgets.p95}ms`);
    }
    if (endpoint.budgets.p99 != null && row.p99_ms == null) {
      failures.push('p99 is missing from summary');
    } else if (endpoint.budgets.p99 != null && row.p99_ms > endpoint.budgets.p99) {
      failures.push(`p99 ${row.p99_ms}ms > budget ${endpoint.budgets.p99}ms`);
    }
    results.push({
      endpoint: endpoint.id,
      path: endpoint.path,
      p95_ms: row.p95_ms ?? null,
      p99_ms: row.p99_ms ?? null,
      budget_p95_ms: endpoint.budgets.p95 ?? null,
      budget_p99_ms: endpoint.budgets.p99 ?? null,
      passed: failures.length === 0,
      reason: failures.join('; ') || null,
    });
  }

  return { passed: results.every((r) => r.passed), results };
}

/** Build a summary that doubles every hot-path latency past the budget. */
export function buildRegressionFixture(budget) {
  return {
    version: budget.version,
    unit: budget.unit,
    profile: 'fixture-regression',
    generatedAt: new Date().toISOString(),
    endpoints: budget.endpoints.map((endpoint) => {
      const budgetP95 = endpoint.budgets.p95 ?? endpoint.budgets.p99;
      const budgetP99 = endpoint.budgets.p99 ?? endpoint.budgets.p95;
      return {
        endpoint: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        p95_ms: budgetP95 * 2,
        p99_ms: budgetP99 * 2,
        budget_p95_ms: endpoint.budgets.p95 ?? null,
        budget_p99_ms: endpoint.budgets.p99 ?? null,
        passed: false,
      };
    }),
  };
}

/** Build a summary that sits comfortably under every budget. */
export function buildPassingFixture(budget) {
  return {
    version: budget.version,
    unit: budget.unit,
    profile: 'fixture-pass',
    generatedAt: new Date().toISOString(),
    endpoints: budget.endpoints.map((endpoint) => {
      const p95Budget = endpoint.budgets.p95;
      const p99Budget = endpoint.budgets.p99;
      return {
        endpoint: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        p95_ms: p95Budget != null ? Math.floor(p95Budget / 2) : null,
        p99_ms: p99Budget != null ? Math.floor(p99Budget / 2) : null,
        budget_p95_ms: p95Budget ?? null,
        budget_p99_ms: p99Budget ?? null,
        passed: true,
      };
    }),
  };
}

function parseArgs(argv) {
  const args = { summary: null, fixtureRegression: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--summary') args.summary = argv[++i];
    else if (a === '--fixture-regression') args.fixtureRegression = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

export function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  if (args.help) {
    io.log(`Usage:
  node scripts/check-performance-budget.mjs
  node scripts/check-performance-budget.mjs --summary <path>
  node scripts/check-performance-budget.mjs --fixture-regression`);
    return 0;
  }

  const budget = loadBudget();

  if (!args.summary && !args.fixtureRegression) {
    io.log(
      `Performance budget OK: ${budget.endpoints.length} hot endpoints ` +
        `(reviewed ${budget.reviewedAt}).`,
    );
    return 0;
  }

  const summary = args.fixtureRegression
    ? buildRegressionFixture(budget)
    : JSON.parse(readFileSync(resolve(args.summary), 'utf-8'));

  const { passed, results } = evaluateSummary(budget, summary);

  if (args.json) {
    io.log(JSON.stringify({ passed, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.passed ? 'PASS' : 'FAIL';
      io.log(
        `[${mark}] ${r.endpoint}` +
          (r.p95_ms != null ? ` p95=${r.p95_ms}ms` : '') +
          (r.p99_ms != null ? ` p99=${r.p99_ms}ms` : '') +
          (r.reason ? ` — ${r.reason}` : ''),
      );
    }
  }

  if (!passed) {
    io.error('Performance budget exceeded.');
    return 1;
  }
  io.log('Performance budget check passed.');
  return 0;
}

const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
  process.argv[1].endsWith('check-performance-budget.mjs')
);

if (isDirectRun) {
  process.exitCode = main();
}
