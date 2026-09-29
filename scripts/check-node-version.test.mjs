import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDockerfile,
  checkImageReferences,
  checkPackageJson,
  checkReadme,
  checkRepository,
  checkWorkflow,
  parseNvmrc,
  run,
} from './check-node-version.mjs';

const V = '20.20.2';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DOCKERFILE = `ARG NODE_VERSION=${V}\nFROM node:\${NODE_VERSION}-alpine AS builder\nFROM node:\${NODE_VERSION}-alpine\n`;
const WORKFLOW = `jobs:
  a:
    steps:
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'pnpm'
      - run: echo hi
`;

/** Build a minimal consistent repo, then let each test break one thing. */
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-node-'));
  temporary.push(dir);
  const files = {
    '.nvmrc': `${V}\n`,
    'package.json': JSON.stringify({ engines: { node: V } }),
    Dockerfile: DOCKERFILE,
    '.github/workflows/ci.yml': WORKFLOW,
    'README.md': `Node.js ${V}\n`,
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:15-alpine\n',
    ...overrides,
  };
  for (const [name, contents] of Object.entries(files)) {
    if (contents === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

describe('the real repository', () => {
  it('names one Node.js version everywhere', () => {
    expect(checkRepository(REPO_ROOT).problems).toEqual([]);
  });
});

describe('.nvmrc', () => {
  it('accepts an exact version, with or without a leading v', () => {
    expect(parseNvmrc('20.20.2\n').version).toBe('20.20.2');
    expect(parseNvmrc('v20.20.2').version).toBe('20.20.2');
  });

  it.each(['20', '20.20', 'lts/*', '20.x', ''])('rejects non-exact "%s"', (value) => {
    expect(parseNvmrc(value).error).toMatch(/exact version/);
  });
});

describe('package.json engines', () => {
  it('passes on a match', () => {
    expect(checkPackageJson(JSON.stringify({ engines: { node: V } }), V)).toEqual([]);
  });
  it('fails on a mismatch, a range, or a missing field', () => {
    expect(checkPackageJson(JSON.stringify({ engines: { node: '22.0.0' } }), V)).toHaveLength(1);
    expect(checkPackageJson(JSON.stringify({ engines: { node: '>=20' } }), V)).toHaveLength(1);
    expect(checkPackageJson('{}', V)[0]).toMatch(/missing/);
  });
});

describe('Dockerfile', () => {
  it('passes when every FROM resolves to the pin', () => {
    expect(checkDockerfile(DOCKERFILE, V)).toEqual([]);
    expect(checkDockerfile(`FROM node:${V}-alpine\nFROM node:${V}\n`, V)).toEqual([]);
  });
  it('fails when the ARG default drifts', () => {
    const problems = checkDockerfile(DOCKERFILE.replace(V, '18.20.0'), V);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/18\.20\.0/);
  });
  it('fails on one stale stage in a multi-stage build', () => {
    const file = `FROM node:${V}-alpine AS builder\nFROM node:18-alpine\n`;
    expect(checkDockerfile(file, V)).toHaveLength(1);
  });
  it('fails on floating tags', () => {
    expect(checkDockerfile('FROM node:20-alpine\n', V)).toHaveLength(1);
    expect(checkDockerfile('FROM node:lts\n', V)).toHaveLength(1);
    expect(checkDockerfile('FROM node\n', V)).toHaveLength(1);
  });
  it('fails when there is no node image at all', () => {
    expect(checkDockerfile('FROM alpine\n', V)[0]).toMatch(/no "FROM node:"/);
  });
});

describe('workflows', () => {
  it('passes for node-version-file: .nvmrc and for the exact version', () => {
    expect(checkWorkflow(WORKFLOW, V, 'ci.yml')).toEqual([]);
    expect(checkWorkflow(WORKFLOW.replace("node-version-file: '.nvmrc'", `node-version: '${V}'`), V, 'ci.yml')).toEqual([]);
  });
  it('fails on a floating or different version', () => {
    for (const value of ["'20.x'", "'20'", "'22.1.0'", 'lts/*']) {
      const text = WORKFLOW.replace("node-version-file: '.nvmrc'", `node-version: ${value}`);
      expect(checkWorkflow(text, V, 'ci.yml')).toHaveLength(1);
    }
  });
  it('fails when setup-node names no version, or the wrong file', () => {
    const none = WORKFLOW.replace("          node-version-file: '.nvmrc'\n", '');
    expect(checkWorkflow(none, V, 'ci.yml')[0]).toMatch(/no node-version-file/);
    const other = WORKFLOW.replace('.nvmrc', '.node-version');
    expect(checkWorkflow(other, V, 'ci.yml')[0]).toMatch(/expected ".nvmrc"/);
  });
  it('checks each setup-node step separately', () => {
    const second = WORKFLOW.replace('a:', 'b:').replace("'.nvmrc'", "'20.x'").replace('jobs:\n', '');
    const problems = checkWorkflow(WORKFLOW + second, V, 'ci.yml');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/20\.x/);
  });
  it('does not read a version from the next step', () => {
    const text = `steps:\n  - uses: actions/setup-node@v4\n  - uses: other/action@v1\n    with:\n      node-version-file: '.nvmrc'\n`;
    expect(checkWorkflow(text, V, 'ci.yml')[0]).toMatch(/no node-version-file/);
  });
});

describe('README', () => {
  it('must state the pinned version', () => {
    expect(checkReadme(`Requires Node.js ${V}`, V)).toEqual([]);
    expect(checkReadme('Requires Node.js 18+', V)).toHaveLength(1);
  });
});

describe('other image references', () => {
  it('flags a mismatched node image but not unrelated images', () => {
    expect(checkImageReferences('image: node:18-alpine\n', V, 'c.yml')).toHaveLength(1);
    expect(checkImageReferences(`image: node:${V}-alpine\n`, V, 'c.yml')).toEqual([]);
    expect(checkImageReferences('image: postgres:15-alpine\n# node:18\n', V, 'c.yml')).toEqual([]);
  });
});

describe('checkRepository / run', () => {
  const silent = { log: () => {}, error: () => {} };

  it('passes on a consistent fixture', () => {
    expect(run(fixture(), silent)).toBe(0);
  });

  it.each([
    ['package.json engines', { 'package.json': JSON.stringify({ engines: { node: '22.0.0' } }) }],
    ['Dockerfile', { Dockerfile: DOCKERFILE.replace(V, '18.20.0') }],
    ['workflow', { '.github/workflows/ci.yml': WORKFLOW.replace("node-version-file: '.nvmrc'", "node-version: '20.x'") }],
    ['.nvmrc', { '.nvmrc': '22.11.0\n' }],
    ['README', { 'README.md': 'Node.js 18+\n' }],
    ['compose', { 'docker-compose.yml': 'services:\n  a:\n    image: node:18-alpine\n' }],
  ])('exits non-zero when only %s is changed', (_name, overrides) => {
    expect(run(fixture(overrides), silent)).toBe(1);
  });

  it('exits non-zero when .nvmrc is missing', () => {
    expect(run(fixture({ '.nvmrc': null }), silent)).toBe(1);
  });

  it('names every offending file', () => {
    const lines = [];
    const dir = fixture({
      Dockerfile: DOCKERFILE.replace(V, '18.20.0'),
      'package.json': JSON.stringify({}),
    });
    run(dir, { log: () => {}, error: (line) => lines.push(line) });
    const out = lines.join('\n');
    expect(out).toMatch(/package\.json/);
    expect(out).toMatch(/Dockerfile:/);
  });
});
