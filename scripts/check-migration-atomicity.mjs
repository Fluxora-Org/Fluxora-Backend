#!/usr/bin/env node

/**
 * Migration atomicity and re-run-safety policy.
 *
 * node-pg-migrate wraps each migration in a single `BEGIN … COMMIT` by default:
 * the ledger insert (`INSERT INTO pgmigrations …`) is queued as the last SQL step
 * *inside* that transaction, so a failure rolls back both the schema change and
 * the version record. That is the property the deploy recovery story relies on —
 * a failed migration leaves the schema at its previous, known version and the
 * migration can simply be re-run.
 *
 * `pgm.noTransaction()` opts a migration out of that wrapper. Those migrations
 * are legitimate (PostgreSQL forbids `CREATE/DROP INDEX CONCURRENTLY` inside a
 * transaction block) but they lose the rollback guarantee: a failure can leave
 * a partially-applied schema with no ledger row. To keep re-runs safe they must
 * be explicitly identified and must consist only of idempotent statements.
 *
 * This script enforces both:
 *   1. every migration that calls `noTransaction()` is listed in
 *      `migrations/atomicity-manifest.json` with a human-readable reason; and
 *   2. every statement in a non-transactional migration is guarded so replaying
 *      it after a partial failure is a no-op (`IF [NOT] EXISTS`), and no
 *      unguarded data mutation runs outside a transaction.
 *
 * Transactional migrations need no idempotency guards: the transaction wrapper
 * is what makes them safe.
 *
 * Usage:
 *   node scripts/check-migration-atomicity.mjs [migrationsDir] [manifestPath]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MIGRATION_FILE = /^\d+.*\.(?:js|ts|mjs|cjs)$/;

export class MigrationAtomicityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationAtomicityError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** Migration file names from a directory listing, excluding helpers and JSON. */
export function migrationFiles(entries) {
  return entries.filter((entry) => MIGRATION_FILE.test(entry)).sort();
}

export function migrationStem(file) {
  return file.replace(/\.(?:js|ts|mjs|cjs)$/, '');
}

/**
 * Remove JavaScript line and block comments without touching string or template
 * literal contents. A small state machine is used because the migrations embed
 * SQL in template literals (including `--` comments and URLs) that a regex would
 * mangle.
 */
export function stripJsComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let quote = null; // "'", '"', or "`"
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) {
          out += next;
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Extract the body of `export [async] function <name>(...) { … }` from source.
 * Returns null when the function is absent. The closing brace is found by
 * balancing braces while skipping strings, template literals, and comments so
 * `{}` inside SQL strings does not terminate the body early.
 */
export function extractFunctionBody(source, name) {
  const header = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*Promise<void>)?\\s*\\{`
  );
  const match = header.exec(source);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  return balancedSlice(source, open).content;
}

/**
 * Given the index of an opening brace/paren/bracket, return the substring
 * between it and its match, respecting nested delimiters, strings, template
 * literals, and comments.
 */
function balancedSlice(source, openIndex) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const close = pairs[source[openIndex]];
  let depth = 0;
  let i = openIndex;
  const n = source.length;
  let quote = null;
  while (i < n) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === source[openIndex]) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { content: source.slice(openIndex + 1, i), end: i };
    }
    i += 1;
  }
  throw new MigrationAtomicityError(
    `Unbalanced "${source[openIndex]}" in migration source`,
    'UNBALANCED_SOURCE',
    { openIndex }
  );
}

/** Find every `pgm.<method>(...)` call in a body and return the raw argument text. */
export function findPgmCalls(body, method) {
  const results = [];
  const pattern = new RegExp(`pgm\\s*\\.\\s*${method}\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(body))) {
    const open = match.index + match[0].length - 1;
    const { content, end } = balancedSlice(body, open);
    results.push({ args: content, index: match.index });
    pattern.lastIndex = end + 1;
  }
  return results;
}

/** True when a migration body opts out of the transaction wrapper. */
export function usesNoTransaction(body) {
  return body !== null && /pgm\s*\.\s*noTransaction\s*\(\s*\)/.test(body);
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$\{[^}]*\}/g, ' ');
}

function normalize(sql) {
  return stripSqlComments(sql).replace(/\s+/g, ' ').trim();
}

/** Strip the surrounding template-literal or string delimiters from SQL text. */
export function unwrapSqlLiteral(args) {
  let text = args.trim();
  const quote = text[0];
  if (quote === '`' || quote === "'" || quote === '"') {
    text = text.endsWith(quote) && text.length >= 2 ? text.slice(1, -1) : text.slice(1);
  }
  return text.trim();
}

/**
 * Assert a single SQL statement is re-runnable. Returns an array of violations
 * (empty when the statement is safe).
 */
export function checkSqlStatement(statement) {
  const sql = normalize(statement);
  if (!sql) return [];

  if (/^(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)) {
    return [
      'data mutation (INSERT/UPDATE/DELETE/TRUNCATE) is not idempotent and must run inside a transaction',
    ];
  }
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(sql) && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) {
    return ['CREATE INDEX must include IF NOT EXISTS to be re-runnable'];
  }
  if (/^CREATE\s+TABLE\b/i.test(sql) && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) {
    return ['CREATE TABLE must include IF NOT EXISTS to be re-runnable'];
  }
  if (/^CREATE\s+EXTENSION\b/i.test(sql) && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) {
    return ['CREATE EXTENSION must include IF NOT EXISTS to be re-runnable'];
  }
  if (/^ALTER\s+TABLE[\s\S]*\bADD\s+COLUMN\b/i.test(sql) && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) {
    return ['ALTER TABLE … ADD COLUMN must include IF NOT EXISTS to be re-runnable'];
  }
  if (
    /^DROP\s+(?:INDEX|TABLE|COLUMN|CONSTRAINT|SEQUENCE)\b/i.test(sql) &&
    !/\bIF\s+EXISTS\b/i.test(sql)
  ) {
    return ['DROP must include IF EXISTS to be re-runnable'];
  }
  return [];
}

/** Split a SQL block into statements (naive on `;`, which is safe for DDL). */
export function checkSqlBlock(sql) {
  const violations = [];
  for (const statement of stripSqlComments(sql).split(';')) {
    if (!statement.trim()) continue;
    for (const problem of checkSqlStatement(statement)) {
      violations.push(problem);
    }
  }
  return violations;
}

/**
 * Collect the non-idempotent constructs in a non-transactional migration body.
 */
export function checkReRunnable(body) {
  const problems = [];

  for (const call of findPgmCalls(body, 'createIndex')) {
    if (!/ifNotExists\s*:\s*true/.test(call.args)) {
      problems.push('pgm.createIndex(…) must set ifNotExists: true outside a transaction');
    }
  }
  for (const call of findPgmCalls(body, 'dropIndex')) {
    if (!/ifExists\s*:\s*true/.test(call.args)) {
      problems.push('pgm.dropIndex(…) must set ifExists: true outside a transaction');
    }
  }
  for (const call of findPgmCalls(body, 'createTable')) {
    if (!/ifNotExists\s*:\s*true/.test(call.args)) {
      problems.push('pgm.createTable(…) must set ifNotExists: true outside a transaction');
    }
  }
  for (const call of findPgmCalls(body, 'sql')) {
    for (const problem of checkSqlBlock(unwrapSqlLiteral(call.args))) {
      problems.push(`pgm.sql(…): ${problem}`);
    }
  }

  return [...new Set(problems)];
}

/** Analyze one migration source and return its atomicity classification. */
export function analyzeMigration(source) {
  const up = extractFunctionBody(source, 'up');
  const down = extractFunctionBody(source, 'down');
  const upNoTransaction = usesNoTransaction(up);
  const downNoTransaction = usesNoTransaction(down);
  const nonTransactional = upNoTransaction || downNoTransaction;
  const problems = nonTransactional
    ? [...checkReRunnable(up ?? ''), ...checkReRunnable(down ?? '')]
    : [];
  return {
    nonTransactional,
    upNoTransaction,
    downNoTransaction,
    problems: [...new Set(problems)],
  };
}

export function readManifest(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new MigrationAtomicityError(
      `Atomicity manifest not found: ${filePath}`,
      'MANIFEST_MISSING'
    );
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = parsed?.nonTransactional;
  if (!Array.isArray(entries)) {
    throw new MigrationAtomicityError(
      'Atomicity manifest must contain a "nonTransactional" array.',
      'MANIFEST_INVALID'
    );
  }
  const names = [];
  for (const entry of entries) {
    if (typeof entry?.name !== 'string' || !entry.name) {
      throw new MigrationAtomicityError(
        'Every nonTransactional manifest entry needs a "name".',
        'MANIFEST_INVALID'
      );
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      throw new MigrationAtomicityError(
        `Non-transactional migration "${entry.name}" needs a descriptive "reason".`,
        'MANIFEST_REASON_MISSING',
        { name: entry.name }
      );
    }
    names.push(entry.name);
  }
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) {
    throw new MigrationAtomicityError(
      `Atomicity manifest lists duplicates: ${[...new Set(duplicates)].join(', ')}`,
      'MANIFEST_DUPLICATE',
      { duplicates: [...new Set(duplicates)] }
    );
  }
  return names;
}

/**
 * Validate the migrations directory against the manifest.
 *
 * @returns {{ transactional: string[], nonTransactional: string[], manifest: number }}
 */
export function checkDirectory({ migrationsDir, manifestPath }) {
  const files = migrationFiles(fs.readdirSync(migrationsDir));
  const manifest = new Set(readManifest(manifestPath));

  const transactional = [];
  const nonTransactional = [];
  const unlisted = [];
  const problems = [];

  for (const file of files) {
    const stem = migrationStem(file);
    const source = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const analysis = analyzeMigration(source);

    if (analysis.nonTransactional) {
      nonTransactional.push(stem);
      if (!manifest.has(stem)) {
        unlisted.push(stem);
        continue;
      }
      if (analysis.problems.length) {
        problems.push({ file, problems: analysis.problems });
      }
    } else {
      transactional.push(stem);
    }
  }

  const known = new Set([...transactional, ...nonTransactional]);
  const stale = [...manifest].filter((name) => !known.has(name));

  if (unlisted.length) {
    throw new MigrationAtomicityError(
      `Migration(s) call pgm.noTransaction() without an atomicity manifest entry: ${unlisted.join(', ')}. ` +
        'Add an entry to migrations/atomicity-manifest.json explaining why the transaction must be skipped.',
      'UNLISTED_NON_TRANSACTIONAL',
      { unlisted }
    );
  }
  if (problems.length) {
    const details = problems
      .map((entry) => `  - ${entry.file}: ${entry.problems.join('; ')}`)
      .join('\n');
    throw new MigrationAtomicityError(
      `Non-transactional migration(s) contain statements that are not safely re-runnable:\n${details}`,
      'NOT_RE_RUNNABLE',
      { problems }
    );
  }
  if (stale.length) {
    throw new MigrationAtomicityError(
      `Atomicity manifest references unknown migration(s): ${stale.join(', ')}. ` +
        'Remove stale entries so the manifest stays accurate.',
      'STALE_MANIFEST',
      { stale }
    );
  }

  return {
    transactional,
    nonTransactional,
    manifest: manifest.size,
  };
}

export function formatResult(result) {
  return [
    `Migration atomicity check passed: ${result.transactional.length} transactional, ` +
      `${result.nonTransactional.length} explicitly non-transactional (${result.manifest} manifested).`,
    'Transactional migrations roll back schema and ledger together; non-transactional migrations are manifest-listed and re-runnable.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const migrationsDir = path.resolve(argv[0] ?? 'migrations');
  const manifestPath = path.resolve(argv[1] ?? path.join(migrationsDir, 'atomicity-manifest.json'));
  try {
    const result = checkDirectory({ migrationsDir, manifestPath });
    console.log(formatResult(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration atomicity check failed: ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
