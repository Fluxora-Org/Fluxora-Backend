import { describe, expect, it } from 'vitest';
import {
  loadBudget,
  validateBudget,
  evaluateSummary,
  buildRegressionFixture,
  buildPassingFixture,
  main,
} from './check-performance-budget.mjs';

describe('performance budget', () => {
  it('loads and validates the recorded hot-endpoint budget', () => {
    const budget = loadBudget();
    expect(budget.endpoints.map((e) => e.id)).toEqual([
      'health',
      'streams_list',
      'streams_get',
      'streams_create',
    ]);
    expect(validateBudget(budget)).toBe(true);
    for (const endpoint of budget.endpoints) {
      expect(endpoint.productionObservation.p99_ms).toBeLessThan(
        endpoint.budgets.p99 ?? endpoint.budgets.p95,
      );
    }
  });

  it('passes when summary latencies stay under budget', () => {
    const budget = loadBudget();
    const summary = buildPassingFixture(budget);
    const { passed, results } = evaluateSummary(budget, summary);
    expect(passed).toBe(true);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails when a hot path doubles latency past the budget', () => {
    const budget = loadBudget();
    const summary = buildRegressionFixture(budget);
    const { passed, results } = evaluateSummary(budget, summary);
    expect(passed).toBe(false);
    expect(results.every((r) => !r.passed)).toBe(true);
    expect(results[0].reason).toMatch(/p99 .+ > budget/);
  });

  it('CLI --fixture-regression exits non-zero', () => {
    const logs = [];
    const errors = [];
    const code = main(['--fixture-regression'], {
      log: (...a) => logs.push(a.join(' ')),
      error: (...a) => errors.push(a.join(' ')),
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/Performance budget exceeded/);
  });
});
