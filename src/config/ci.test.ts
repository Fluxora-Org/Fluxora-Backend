import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

const wf = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

function parseJobs(workflow) {
  const jobsSection = workflow.slice(workflow.indexOf('\njobs:') + 1);
  const lines = jobsSection.split('\n');
  const jobs = {};
  let current = null;
  for (const line of lines) {
    const header = /^ {2}([\w-]+):\s*$/.exec(line);
    const doesNotBelong = /^ {4,}/.test(line) || line.trim() === '';
    if (header) {
      current = header[1];
      jobs[current] = [];
    } else if (current && !doesNotBelong) {
      break; // reached a key after the last job (e.g. 0-indent) — stop
    } else if (current) {
      jobs[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

const jobs = parseJobs(wf);

test('required checks do not continue on error', () => {
  for (const j of ['typecheck', 'lint', 'test', 'security', 'docker']) {
    expect(jobs[j], `missing required job '${j}'`).toBeTruthy();
    expect(/^\s*continue-on-error:\s*true\s*$/m.test(jobs[j]), `${j} must fail closed`).toBe(false);
  }
});

test('lint job runs the deterministic changed-files linter', () => {
  expect(jobs.lint).toContain('pnpm run lint:ci');
});

test('lint job has no shell fallback that masks a missing ESLint configuration', () => {
  // A trailing `|| echo ...` (or any `||`-guarded continuation) would let CI
  // pass when ESLint is missing or misconfigured. The lint step must run the
  // linter directly so any failure — including a missing ESLint config — fails
  // the workflow.
  expect(/run:\s*\S*lint:?ci[^\n]*\s*\|\|\s*/.test(jobs.lint)).toBe(false);
});

test('informational jobs are marked', () => {
  for (const [j, b] of Object.entries(jobs)) {
    if (/^\s*continue-on-error:\s*true\s*$/m.test(b)) {
      expect(b).toMatch(/informational/i);
    }
  }
});
