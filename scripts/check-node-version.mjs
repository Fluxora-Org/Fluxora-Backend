#!/usr/bin/env node
/**
 * Fails when the repository does not name exactly one Node.js version.
 *
 * Source of truth: `.nvmrc` (an exact `MAJOR.MINOR.PATCH`, e.g. `20.20.2`).
 * Everything else must agree with it:
 *
 *   - package.json            "engines.node" must equal it exactly
 *   - Dockerfile              every `FROM node:<tag>` must resolve to it
 *                             (directly, or via `ARG NODE_VERSION=<version>`)
 *   - .github/workflows/*.yml every `actions/setup-node` step must use
 *                             `node-version-file: .nvmrc` or the exact version
 *   - README.md               must state the pinned version
 *   - docker-compose*.yml,    any other `node:<version>` image reference must
 *     workflows               equal it
 *
 * To upgrade Node.js, change all of the above in ONE pull request. Run
 * `pnpm run check:node-version` to see what is left to change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const NVMRC = '.nvmrc';

/** Strip a trailing YAML comment and surrounding quotes/whitespace. */
export function cleanYamlScalar(raw) {
  let value = raw.trim();
  const quoted = /^(['"])(.*?)\1/.exec(value);
  if (quoted) return quoted[2].trim();
  value = value.replace(/\s+#.*$/, '').trim();
  return value;
}

/** Read the pinned version from `.nvmrc` contents. Returns { version, error }. */
export function parseNvmrc(contents) {
  const version = contents.trim().replace(/^v/, '');
  if (!EXACT_VERSION.test(version)) {
    return {
      version: null,
      error: `${NVMRC} must contain one exact version like 20.20.2, found "${contents.trim()}"`,
    };
  }
  return { version, error: null };
}

/** Compare package.json engines.node with the pinned version. */
export function checkPackageJson(contents, pinned) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return [`package.json is not valid JSON: ${error.message}`];
  }
  const engines = parsed.engines && parsed.engines.node;
  if (typeof engines !== 'string') {
    return [`package.json is missing "engines.node" (expected "${pinned}")`];
  }
  if (engines.trim() !== pinned) {
    return [`package.json engines.node is "${engines}", expected "${pinned}"`];
  }
  return [];
}

/**
 * Check every `FROM node:<tag>` in a Dockerfile. `ARG NODE_VERSION=<v>` ahead of
 * the first FROM is honoured so the version lives in a single line.
 */
export function checkDockerfile(contents, pinned, file = 'Dockerfile') {
  const problems = [];
  const args = new Map();
  let sawNodeImage = false;

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const where = `${file}:${index + 1}`;
    const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/.exec(line);
    if (arg) args.set(arg[1], cleanYamlScalar(arg[2]));

    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (!from) continue;
    const image = from[1];
    if (!/^node(:|$|@)/.test(image)) continue;
    sawNodeImage = true;

    const tag = /^node:(.+)$/.exec(image);
    if (!tag) {
      problems.push(`${where}: "${image}" does not name a Node.js version`);
      continue;
    }
    const resolved = tag[1].replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) =>
      args.has(name) ? args.get(name) : whole,
    );
    const leading = /^(\d+\.\d+\.\d+)(?:-|$)/.exec(resolved);
    if (!leading) {
      problems.push(`${where}: "${image}" must pin an exact version (expected ${pinned})`);
    } else if (leading[1] !== pinned) {
      problems.push(`${where}: "${image}" uses Node.js ${leading[1]}, expected ${pinned}`);
    }
  }

  if (!sawNodeImage) problems.push(`${file}: no "FROM node:" line found`);
  return problems;
}

/** Check every `actions/setup-node` step in one workflow file. */
export function checkWorkflow(contents, pinned, file) {
  const problems = [];
  const lines = contents.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const uses = /^(\s*)(-\s+)?uses:\s*actions\/setup-node@/.exec(lines[i]);
    if (!uses) continue;

    // Keys of one step share an indent; `- uses:` puts the key after the "- ".
    // Read forward until the step ends (a dedent, or the next "- " list item).
    const keyIndent = uses[1].length + (uses[2] ? uses[2].length : 0);
    let end = i + 1;
    while (end < lines.length) {
      const text = lines[end];
      const indent = /^(\s*)/.exec(text)[1].length;
      if (text.trim() !== '' && indent < keyIndent) break;
      if (/^\s*-\s/.test(text) && indent <= keyIndent - 2) break;
      end += 1;
    }

    const block = lines.slice(i, end);
    const where = `${file}:${i + 1}`;
    let version = null;
    let versionFile = null;
    for (const text of block) {
      const v = /^\s*node-version:\s*(.+)$/.exec(text);
      const f = /^\s*node-version-file:\s*(.+)$/.exec(text);
      if (v) version = cleanYamlScalar(v[1]);
      if (f) versionFile = cleanYamlScalar(f[1]);
    }

    if (versionFile !== null && version !== null) {
      problems.push(`${where}: set only one of node-version and node-version-file`);
    } else if (versionFile !== null) {
      if (path.posix.normalize(versionFile) !== NVMRC) {
        problems.push(`${where}: node-version-file is "${versionFile}", expected "${NVMRC}"`);
      }
    } else if (version !== null) {
      if (version.replace(/^v/, '') !== pinned) {
        problems.push(`${where}: node-version is "${version}", expected "${pinned}"`);
      }
    } else {
      problems.push(
        `${where}: actions/setup-node has no node-version-file: ${NVMRC}; it would use whatever Node.js the runner ships`,
      );
    }
  }
  return problems;
}

/** The README must state the pinned version. */
export function checkReadme(contents, pinned) {
  return contents.includes(pinned)
    ? []
    : [`README.md does not state the pinned Node.js version ${pinned}`];
}

/** Catch other `node:<version>` image references (compose, `container:`, etc.). */
export function checkImageReferences(contents, pinned, file) {
  const problems = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/(?<![\w./-])node:(\d[\w.-]*)/g)) {
      const leading = /^(\d+\.\d+\.\d+)(?:-|$)/.exec(match[1]);
      if (!leading || leading[1] !== pinned) {
        problems.push(
          `${file}:${index + 1}: image "node:${match[1]}" does not match Node.js ${pinned}`,
        );
      }
    }
  }
  return problems;
}

function listFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Run every check against a repository root. Returns { version, problems }. */
export function checkRepository(rootDir) {
  const rel = (file) => path.relative(rootDir, file).split(path.sep).join('/');
  const read = (file) => fs.readFileSync(file, 'utf8');
  const problems = [];

  const nvmrcPath = path.join(rootDir, NVMRC);
  if (!fs.existsSync(nvmrcPath)) {
    return { version: null, problems: [`${NVMRC} is missing; it holds the pinned Node.js version`] };
  }
  const { version, error } = parseNvmrc(read(nvmrcPath));
  if (error) return { version: null, problems: [error] };

  const packagePath = path.join(rootDir, 'package.json');
  if (fs.existsSync(packagePath)) problems.push(...checkPackageJson(read(packagePath), version));
  else problems.push('package.json is missing');

  const readmePath = path.join(rootDir, 'README.md');
  if (fs.existsSync(readmePath)) problems.push(...checkReadme(read(readmePath), version));
  else problems.push('README.md is missing');

  const dockerfiles = listFiles(rootDir, /^Dockerfile(\..+)?$/);
  if (dockerfiles.length === 0) problems.push('Dockerfile is missing');
  for (const file of dockerfiles) problems.push(...checkDockerfile(read(file), version, rel(file)));

  const workflows = listFiles(path.join(rootDir, '.github', 'workflows'), /\.ya?ml$/);
  for (const file of workflows) {
    problems.push(...checkWorkflow(read(file), version, rel(file)));
    problems.push(...checkImageReferences(read(file), version, rel(file)));
  }

  for (const file of listFiles(rootDir, /^(docker-)?compose.*\.ya?ml$/)) {
    problems.push(...checkImageReferences(read(file), version, rel(file)));
  }

  return { version, problems };
}

export function run(rootDir, log = console) {
  const { version, problems } = checkRepository(rootDir);
  if (problems.length === 0) {
    log.log(`Node.js version pin OK: ${version} in ${NVMRC}, package.json, Dockerfile and workflows.`);
    return 0;
  }
  log.error(`Node.js version pin mismatch${version ? ` (pinned: ${version} in ${NVMRC})` : ''}:`);
  for (const problem of problems) log.error(`  - ${problem}`);
  log.error(
    `\nUpgrade Node.js in one change: update ${NVMRC}, package.json engines.node, the Dockerfile ARG NODE_VERSION, and the version in README.md.`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
