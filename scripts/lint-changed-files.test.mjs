import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedTypeScriptFiles, lintFiles } from './lint-changed-files.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const SCRIPT = new URL('./lint-changed-files.mjs', import.meta.url).pathname;

// Scratch dir lives under src/ so ESLint's type-aware project (tsconfig.eslint.json
// includes src/**) accepts the generated files. It is created and removed per test.
let scratch = null;

beforeEach(() => {
  scratch = path.join(ROOT, 'src', '__lint_smoke__');
  fs.mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  delete process.env.LINT_FILES;
});

function source(name, content) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, content);
  return file;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function runCli(files) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LINT_FILES: files.join('\n') },
  });
}

describe('changed-files lint scoping', () => {
  it('keeps only in-scope TypeScript files under src/ and tests/', () => {
    process.env.LINT_FILES = ['src/app.ts', 'tests/x.test.ts', 'scripts/gen.mjs', 'docs/guide.md', 'eslint.config.js']
      .join('\n');
    expect(changedTypeScriptFiles()).toEqual(['src/app.ts', 'tests/x.test.ts']);
  });

  it('returns an empty list when no in-scope files are provided', () => {
    process.env.LINT_FILES = '';
    expect(changedTypeScriptFiles()).toEqual([]);
  });
});

describe('lintFiles rejects deliberate violations', () => {
  it('flags a no-console violation as an error', async () => {
    const dirty = source('dirty.ts', 'export function bad(): void {\n  console.log("boom");\n}\n');
    const { results } = await lintFiles([dirty]);
    const errors = results.reduce((n, r) => n + r.errorCount, 0);
    expect(errors).toBeGreaterThan(0);
    expect(results[0].messages.some((m) => m.ruleId === 'no-console')).toBe(true);
  });

  it('passes a clean file with zero warnings and errors', async () => {
    const clean = source('clean.ts', 'export function good(): string {\n  return "ok";\n}\n');
    const { results } = await lintFiles([clean]);
    const total = results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);
    expect(total).toBe(0);
  });
});

describe('CLI exit codes are deterministic', () => {
  const CLI_TIMEOUT = 60000;

  it('exits 1 when a changed file carries a deliberate violation', () => {
    const dirty = source('dirty.ts', 'export function bad(): void {\n  console.log("boom");\n}\n');
    const res = runCli([rel(dirty)]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/no-console/);
  }, CLI_TIMEOUT);

  it('exits 0 for a clean changed file', () => {
    const clean = source('clean.ts', 'export function good(): string {\n  return "ok";\n}\n');
    expect(runCli([rel(clean)]).status).toBe(0);
  }, CLI_TIMEOUT);

  it('exits 0 when there are no in-scope changed files', () => {
    const res = runCli(['eslint.config.js', 'scripts/gen.mjs']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no changed TypeScript files/);
  }, CLI_TIMEOUT);
});
