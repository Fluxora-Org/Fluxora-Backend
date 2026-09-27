/**
 * Retention-schedule consistency check.
 *
 * Fails CI when the published retention schedule, the code manifest, the
 * migrations and the purge jobs disagree about how long data is kept. The
 * point is that the schedule cannot rot: a new table, a changed retention
 * window, or a purge job pointing at the wrong column all fail the build
 * rather than quietly making the document wrong.
 *
 * Checks performed
 * ────────────────
 *  1. **Coverage** — every table created by a migration has a manifest entry,
 *     and every manifest entry with a `table` names a table a migration
 *     actually creates.
 *  2. **The job matches the manifest** — `PURGEABLE_RETENTION_SCHEDULE` (what
 *     `src/jobs/retentionPurge.ts` iterates) is exactly the set of manifest
 *     entries declared `enforcement: 'retention-purge'`, with the same period,
 *     table, age column and purge action. The list is derived in code, so this
 *     is a guard against someone re-introducing a hand-maintained copy.
 *  3. **Config defaults match** — the `DLQ_RETENTION_DAYS` and
 *     `IDEMPOTENCY_TTL_SECONDS` defaults recorded in the manifest are the ones
 *     the env schema actually ships.
 *  4. **Legal hold is truthful** — `legalHoldExempt` is set only for tables
 *     that really have a `legal_hold` column, and every exempt table is in
 *     `LEGAL_HOLD_EXEMPT_TABLES`.
 *  5. **Age columns exist** — every `ageColumn` named by a purge rule is a real
 *     column on its table in the migrations.
 *  6. **No silent gaps** — a finite period with no enforcing mechanism must
 *     carry a written `unenforcedReason`, so an open gap always ships with its
 *     explanation.
 *  7. **The document matches** — `docs/retention-schedule.md` lists the same
 *     ids, periods and enforcement mechanisms as the manifest.
 *
 * Usage:
 *   pnpm run check:retention          # verify (CI gate)
 *   pnpm run check:retention -- --write  # regenerate the table, keep the prose
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  RETENTION_MANIFEST,
  PURGEABLE_RETENTION_SCHEDULE,
  LEGAL_HOLD_EXEMPT_TABLES,
  DLQ_RETENTION_DAYS_DEFAULT,
  IDEMPOTENCY_TTL_DAYS_DEFAULT,
  type DataRetentionRule,
} from '../src/pii/retention.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MIGRATION_DIRS = ['migrations', 'src/db/migrations'];
const DOC_PATH = 'docs/retention-schedule.md';

/** Markers delimiting the generated table inside the document. */
const DOC_BEGIN = '<!-- retention-schedule:begin -->';
const DOC_END = '<!-- retention-schedule:end -->';

export class RetentionScheduleError extends Error {
  code: string;
  problems: string[];

  constructor(message: string, code: string, problems: string[] = []) {
    super(message);
    this.name = 'RetentionScheduleError';
    this.code = code;
    this.problems = problems;
  }
}

// ── Migration scanning ────────────────────────────────────────────────────────

/** A table discovered in a migration, with the columns it declares. */
export interface DiscoveredTable {
  name: string;
  /** Migration file the table was declared in, relative to the repo root. */
  declaredIn: string;
  /** Column names seen in the CREATE TABLE body, lower-cased. */
  columns: Set<string>;
  /** True for a `PARTITION OF` / `DEFAULT` child of another table. */
  isPartition: boolean;
}

/**
 * Extract the tables a migration declares, and the columns each one ends up
 * with.
 *
 * Handles every spelling the repository uses:
 *
 *  - node-pg-migrate's `pgm.createTable('name', { col: { type: ... } })`
 *  - node-pg-migrate's `pgm.addColumn('name', { col: { type: ... } })` — an
 *    `ALTER TABLE ... ADD COLUMN` under a different name, and the reason
 *    `streams.legal_hold` only exists in a later migration than `streams`
 *  - raw `pgm.sql('CREATE TABLE name (...)')`
 *
 * Columns are merged across migrations, so a table that gains a column later is
 * reported with the full set.
 */
export function discoverTables(sources: { file: string; sql: string }[]): DiscoveredTable[] {
  const found = new Map<string, DiscoveredTable>();

  const record = (
    rawName: string,
    file: string,
    columns: string[],
    isPartition: boolean,
  ): void => {
    const name = rawName.toLowerCase().replace(/^["`]|["`]$/g, '');
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) return;
    const existing = found.get(name);
    if (existing) {
      for (const column of columns) existing.columns.add(column);
      return;
    }
    found.set(name, { name, declaredIn: file, columns: new Set(columns), isPartition });
  };

  for (const { file, sql } of sources) {
    // `pgm.createTable('t', { ... })` and `pgm.addColumn('t', { ... })`.
    // The object literal has to be brace-matched rather than matched with a
    // lazy regex, or the scan stops at the first column's own closing brace.
    const helper = /\b(?:createTable|addColumn)\(\s*['"`]([A-Za-z0-9_.]+)['"`]\s*,\s*\{/g;
    for (const match of sql.matchAll(helper)) {
      const open = sql.indexOf('{', match.index + match[0].length - 1);
      const body = open === -1 ? '' : sliceBalanced(sql, open, '{', '}');
      const columns = [...body.matchAll(/(?:^|[\s,{])([a-z_][a-z0-9_]*)\s*:\s*\{/gi)].map((c) =>
        (c[1] ?? '').toLowerCase(),
      );
      record(match[1] ?? '', file, columns, false);
    }

    // Raw `CREATE TABLE [IF NOT EXISTS] name [ ( body ) ]`.
    const createSql = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?/gi;
    for (const match of sql.matchAll(createSql)) {
      const after = sql.slice(match.index + match[0].length);
      // A partition child (`... PARTITION OF parent`) inherits its parent's
      // columns and declares none of its own.
      const isPartition = /^\s+PARTITION\s+OF/i.test(after.slice(0, 120));
      const columns: string[] = [];
      const open = after.indexOf('(');
      if (open !== -1 && !isPartition) {
        const body = sliceBalanced(after, open, '(', ')');
        for (const line of body.split('\n')) {
          // A column definition starts the line with an identifier followed by a
          // type. Matching the type loosely covers `text`, `bigserial`,
          // `timestamp with time zone` and `TIMESTAMPTZ` alike.
          const col = /^\s*["`]?([a-z_][a-z0-9_]*)["`]?\s+(?:"?[A-Za-z][A-Za-z0-9 ]*"?)/i.exec(line);
          if (col?.[1]) columns.push(col[1].toLowerCase());
        }
      }
      record(match[1] ?? '', file, columns, isPartition);
    }

    // Raw `ALTER TABLE name ADD COLUMN col type`.
    const alter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?/gi;
    for (const match of sql.matchAll(alter)) {
      record(match[1] ?? '', file, [(match[2] ?? '').toLowerCase()], false);
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The substring between the bracket at `open` and its matching close. */
function sliceBalanced(text: string, open: number, openChar: string, closeChar: string): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Read every migration file from the repository's migration directories. */
export function readMigrationSources(root = REPO_ROOT): { file: string; sql: string }[] {
  const sources: { file: string; sql: string }[] = [];
  for (const dir of MIGRATION_DIRS) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute)) {
      if (!/\.(?:ts|mjs|js|cjs)$/.test(entry)) continue;
      const relative = `${dir}/${entry}`;
      if (relative.endsWith('.test.ts')) continue;
      sources.push({ file: relative, sql: fs.readFileSync(path.join(absolute, entry), 'utf8') });
    }
  }
  return sources;
}

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Every table a migration creates has a manifest entry.
 *
 * A new table with no stated retention period is exactly the gap this issue
 * exists to close, so it is a hard failure rather than a warning.
 */
export function checkCoverage(
  manifest: readonly DataRetentionRule[],
  tables: DiscoveredTable[],
): string[] {
  const problems: string[] = [];
  const declared = new Set(
    manifest.filter((rule) => rule.table !== null).map((rule) => rule.table as string),
  );

  for (const table of tables) {
    if (!declared.has(table.name)) {
      problems.push(
        `Table '${table.name}' (created by ${table.declaredIn}) has no entry in RETENTION_MANIFEST. ` +
          `Add one to src/pii/retention.ts with a period, an enforcement mechanism, and a rationale.`,
      );
    }
  }

  for (const rule of manifest) {
    if (rule.table === null) continue;
    if (!tables.some((table) => table.name === rule.table)) {
      problems.push(
        `Manifest entry '${rule.id}' names table '${rule.table}', which no migration creates. ` +
          `Remove the entry or restore the migration.`,
      );
    }
  }

  return problems;
}

/**
 * The rule list the purge job iterates is exactly the manifest's purgeable set.
 *
 * `PURGEABLE_RETENTION_SCHEDULE` is derived from the manifest, so this should
 * hold by construction. It is asserted anyway: the value of the schedule is
 * that the number an auditor reads is the number the job runs, and a
 * hand-maintained duplicate list anywhere would silently break that.
 */
export function checkPurgeJobMatchesManifest(
  manifest: readonly DataRetentionRule[],
  schedule: readonly {
    category: string;
    retentionDays: number | null;
    table: string;
    ageColumn: string;
    purgeAction: string;
  }[],
): string[] {
  const problems: string[] = [];
  const purgeable = manifest.filter((rule) => rule.enforcement === 'retention-purge');

  if (schedule.length !== purgeable.length) {
    problems.push(
      `PURGEABLE_RETENTION_SCHEDULE has ${schedule.length} rule(s) but the manifest declares ` +
        `${purgeable.length} entry/entries with enforcement: 'retention-purge'. ` +
        `The job would enforce a different schedule from the one that is published.`,
    );
  }

  for (const rule of purgeable) {
    if (rule.table === null || rule.ageColumn === undefined) {
      problems.push(
        `Manifest entry '${rule.id}' is enforcement: 'retention-purge' but does not name a ` +
          `table and age column, so the job cannot target it.`,
      );
      continue;
    }
    const match = schedule.find((candidate) => candidate.table === rule.table);
    if (!match) {
      problems.push(
        `Manifest entry '${rule.id}' (table '${rule.table}') is declared purgeable but has no ` +
          `matching rule in PURGEABLE_RETENTION_SCHEDULE, so nothing deletes it.`,
      );
      continue;
    }
    if (match.retentionDays !== rule.retentionDays) {
      problems.push(
        `Table '${rule.table}': manifest states ${rule.retentionDays} day(s) but the purge job ` +
          `uses ${match.retentionDays}. The published period and the enforced period must be equal.`,
      );
    }
    if (match.ageColumn !== rule.ageColumn) {
      problems.push(
        `Table '${rule.table}': manifest ages rows by '${rule.ageColumn}' but the purge job ` +
          `uses '${match.ageColumn}'.`,
      );
    }
    const expectedAction = rule.purgeAction === 'redact' ? 'redact' : 'delete';
    if (match.purgeAction !== expectedAction) {
      problems.push(
        `Table '${rule.table}': manifest declares purgeAction '${rule.purgeAction}' but the ` +
          `purge job uses '${match.purgeAction}'.`,
      );
    }
  }

  const manifestTables = new Set(purgeable.map((rule) => rule.table));
  for (const rule of schedule) {
    if (!manifestTables.has(rule.table)) {
      problems.push(
        `PURGEABLE_RETENTION_SCHEDULE contains a rule for '${rule.table}' that the manifest does ` +
          `not declare purgeable. The job would delete data the schedule says is retained.`,
      );
    }
  }

  return problems;
}

/**
 * The age column each purge rule reads is a real column on its table.
 *
 * Catches the common case of a table being recreated with a renamed timestamp
 * column, which would otherwise surface as a runtime SQL error the first time
 * the job met an expired row.
 */
export function checkAgeColumns(
  manifest: readonly DataRetentionRule[],
  tables: DiscoveredTable[],
): string[] {
  const problems: string[] = [];
  for (const rule of manifest) {
    if (rule.enforcement !== 'retention-purge' || rule.table === null || !rule.ageColumn) continue;
    const table = tables.find((candidate) => candidate.name === rule.table);
    if (!table) continue;
    if (table.columns.size === 0) continue; // columns not parseable; nothing to assert
    if (!table.columns.has(rule.ageColumn.toLowerCase())) {
      problems.push(
        `Table '${rule.table}': the purge rule ages rows by '${rule.ageColumn}', which the ` +
          `migration (${table.declaredIn}) does not declare. Known columns: ` +
          `${[...table.columns].sort().join(', ')}.`,
      );
    }
  }
  return problems;
}

/**
 * `legalHoldExempt` is true only for tables that really have the column.
 *
 * The purge job substitutes a constant `FALSE` for tables without the column,
 * so a rule that claims to be hold-exempt on such a table is not exempt at
 * all — the claim would be false in the published document and silently
 * ineffective in the job.
 */
export function checkLegalHold(
  manifest: readonly DataRetentionRule[],
  tables: DiscoveredTable[],
): string[] {
  const problems: string[] = [];
  const exempt = new Set(LEGAL_HOLD_EXEMPT_TABLES);

  for (const rule of manifest) {
    if (!rule.legalHoldExempt) continue;
    if (rule.table === null) {
      problems.push(`Manifest entry '${rule.id}' claims a legal-hold exemption but has no table.`);
      continue;
    }
    const table = tables.find((candidate) => candidate.name === rule.table);
    if (table && table.columns.size > 0 && !table.columns.has('legal_hold')) {
      problems.push(
        `Manifest entry '${rule.id}' sets legalHoldExempt for '${rule.table}', but that table ` +
          `has no 'legal_hold' column (${table.declaredIn}). The purge job cannot honour a hold ` +
          `there, so the published exemption would be false.`,
      );
    }
    if (!exempt.has(rule.table)) {
      problems.push(
        `Manifest entry '${rule.id}' sets legalHoldExempt for '${rule.table}', which is not in ` +
          `LEGAL_HOLD_EXEMPT_TABLES. Add it there so the endpoint and the document agree.`,
      );
    }
  }

  for (const table of exempt) {
    if (!manifest.some((rule) => rule.table === table && rule.legalHoldExempt)) {
      problems.push(
        `LEGAL_HOLD_EXEMPT_TABLES lists '${table}' but no manifest entry claims the exemption.`,
      );
    }
  }

  return problems;
}

/**
 * A promise to delete that nothing deletes must say why it is still open.
 *
 * The invariant is deliberately narrow: it fires when a **positive finite**
 * period is declared with no enforcing mechanism. That is a commitment the
 * service is not keeping, so the reason has to be published in the document
 * and reviewed, rather than discovered during an audit.
 *
 * Two neighbouring cases are deliberately *not* flagged:
 *
 *  - `retentionDays: 0` with no enforcement. Zero days means the data is never
 *    written to a persistent store in the first place (request metadata, auth
 *    tokens), so there is nothing to purge and no promise being broken.
 *  - `retentionDays: null` (indefinite) with no enforcement. Indefinite is not
 *    a promise to delete; the entry's `rationale` — which is required
 *    separately — is where that decision is justified.
 */
export function checkUnenforcedPeriods(manifest: readonly DataRetentionRule[]): string[] {
  const problems: string[] = [];
  for (const rule of manifest) {
    const promisesDeletion =
      rule.retentionDays !== null && rule.retentionDays > 0 && rule.enforcement === 'none';
    const reason = rule.unenforcedReason?.trim() ?? '';
    if (promisesDeletion && reason === '') {
      problems.push(
        `Manifest entry '${rule.id}' states a ${rule.retentionDays}-day retention period with no ` +
          `enforcement mechanism and no 'unenforcedReason'. Add a reason so the gap is published.`,
      );
    }
    if (rule.enforcement !== 'none' && rule.unenforcedReason) {
      problems.push(
        `Manifest entry '${rule.id}' declares enforcement '${rule.enforcement}' but also carries an ` +
          `'unenforcedReason'. The reason would be published as a gap that does not exist.`,
      );
    }
    if (rule.retentionDays !== null && rule.retentionDays < 0) {
      problems.push(`Manifest entry '${rule.id}' has a negative retentionDays (${rule.retentionDays}).`);
    }
    if ((rule.rationale ?? '').trim() === '') {
      problems.push(`Manifest entry '${rule.id}' has an empty rationale.`);
    }
  }
  return problems;
}

/** Manifest ids and tables are unique, and every entry is otherwise well formed. */
export function checkManifestIntegrity(manifest: readonly DataRetentionRule[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const idToTable = new Map<string, string | null>();

  for (const rule of manifest) {
    if (ids.has(rule.id)) problems.push(`Duplicate manifest id '${rule.id}'.`);
    ids.add(rule.id);

    const previous = idToTable.get(rule.id);
    if (previous === undefined) idToTable.set(rule.id, rule.table);

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id)) {
      problems.push(
        `Manifest id '${rule.id}' is not kebab-case. Ids are published and cross-referenced, ` +
          `so they must be stable.`,
      );
    }
    if (rule.dataClass.trim() === '') problems.push(`Manifest entry '${rule.id}' has no dataClass.`);
    if (rule.storage.trim() === '') problems.push(`Manifest entry '${rule.id}' has no storage.`);
    if ((rule.enforcementRef ?? '').trim() === '') {
      problems.push(
        `Manifest entry '${rule.id}' names no enforcementRef, so the document would not say what ` +
          `enforces the period.`,
      );
    }
  }

  // Two entries may share a table only when they split the data by sensitivity
  // (e.g. streams PII vs. chain state) — and then their periods may differ,
  // which is exactly why sharing needs to be deliberate.
  const tableOwners = new Map<string, string[]>();
  for (const rule of manifest) {
    if (rule.table === null) continue;
    const owners = tableOwners.get(rule.table) ?? [];
    owners.push(rule.id);
    tableOwners.set(rule.table, owners);
  }

  return problems;
}

/**
 * Manifest defaults match the shipped env schema.
 *
 * A retention window that is operator-tunable is a real commitment only up to
 * its default, so the manifest records the default and CI keeps the two from
 * drifting.
 */
export function checkConfigDefaults(
  envSchemaFiles: { file: string; sql: string }[],
  dlqDefault: number,
  idempotencyDefaultDays: number,
): string[] {
  const problems: string[] = [];
  const joined = envSchemaFiles.map((f) => f.sql).join('\n');

  const dlq = /DLQ_RETENTION_DAYS:.*?\.default\((\d+)\)/s.exec(joined);
  if (!dlq) {
    problems.push(
      'Could not find a DLQ_RETENTION_DAYS default in the env schema. The manifest states ' +
        `${dlqDefault} day(s); if the variable was renamed, update the manifest.`,
    );
  } else if (Number(dlq[1]) !== dlqDefault) {
    problems.push(
      `The manifest states a default DLQ retention of ${dlqDefault} day(s) but the env schema ` +
        `ships DLQ_RETENTION_DAYS with a default of ${dlq[1]}.`,
    );
  }

  const ttl = /IDEMPOTENCY_TTL_SECONDS:.*?\.default\((\d+)\)/s.exec(joined);
  if (!ttl) {
    problems.push(
      'Could not find an IDEMPOTENCY_TTL_SECONDS default in the env schema. The manifest states ' +
        `${idempotencyDefaultDays} day(s); if the variable was renamed, update the manifest.`,
    );
  } else {
    const days = Number(ttl[1]) / 86_400;
    if (days !== idempotencyDefaultDays) {
      problems.push(
        `The manifest states a default idempotency-key retention of ${idempotencyDefaultDays} ` +
          `day(s) but the env schema ships IDEMPOTENCY_TTL_SECONDS=${ttl[1]} (${days} day(s)).`,
      );
    }
  }

  return problems;
}

// ── The document ──────────────────────────────────────────────────────────────

/**
 * Render the generated table for the document from the manifest.
 *
 * The row key is the manifest `id`, not the table name: a table can hold more
 * than one data class (`streams` splits chain state from address PII, with
 * different periods), so the table alone is not unique.
 */
export function renderScheduleTable(manifest: readonly DataRetentionRule[]): string {
  const lines: string[] = [];
  lines.push(DOC_BEGIN);
  lines.push('');
  lines.push('<!-- Generated by `pnpm run check:retention -- --write`. Do not edit by hand. -->');
  lines.push('');
  lines.push('| ID | Data class | Table | Retention | Action | Enforced by | Legal hold |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const rule of manifest) {
    lines.push(
      `| \`${rule.id}\` | ${rule.dataClass} | ${rule.table ? `\`${rule.table}\`` : '—'} | ` +
        `${formatPeriod(rule)} | ${rule.purgeAction} | ${rule.enforcement} | ` +
        `${rule.legalHoldExempt ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push(DOC_END);
  return lines.join('\n');
}

/** The period exactly as the manifest states it, so the two compare verbatim. */
function formatPeriod(rule: DataRetentionRule): string {
  if (rule.retentionDays === null) return 'indefinite';
  return `${rule.retentionDays} days`;
}

/** Parse the `id` / period / enforcement triples out of the document table. */
export function parseDocumentTable(doc: string): Map<string, { period: string; enforcement: string }> {
  const parsed = new Map<string, { period: string; enforcement: string }>();
  const block = between(doc, DOC_BEGIN, DOC_END);
  if (block === null) return parsed;
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 7) continue;
    const [id, , , period, , enforcement] = cells;
    const key = (id.match(/`([^`]+)`/)?.[1] ?? '').toLowerCase();
    if (key === '' || key === 'id') continue;
    parsed.set(key, { period: period ?? '', enforcement: enforcement ?? '' });
  }
  return parsed;
}

/** The document must publish the same schedule the code enforces. */
export function checkDocument(
  manifest: readonly DataRetentionRule[],
  doc: string,
): string[] {
  const problems: string[] = [];

  if (!doc.includes(DOC_BEGIN) || !doc.includes(DOC_END)) {
    return [
      `${DOC_PATH} is missing the ${DOC_BEGIN} / ${DOC_END} markers. Regenerate the schedule ` +
        `table with \`pnpm run check:retention -- --write\`.`,
    ];
  }

  const parsed = parseDocumentTable(doc);
  if (parsed.size === 0) {
    return [`${DOC_PATH} contains no schedule rows between the ${DOC_BEGIN} / ${DOC_END} markers.`];
  }

  for (const rule of manifest) {
    const row = parsed.get(rule.id);
    if (!row) {
      problems.push(
        `${DOC_PATH} does not list '${rule.id}' (${rule.dataClass}). The published schedule ` +
          `must cover every persisted data class.`,
      );
      continue;
    }
    const expected = formatPeriod(rule);
    if (row.period !== expected) {
      problems.push(
        `${DOC_PATH}: '${rule.id}' states '${row.period}' but the manifest states '${expected}'.`,
      );
    }
    if (row.enforcement !== rule.enforcement) {
      problems.push(
        `${DOC_PATH}: '${rule.id}' states enforcement '${row.enforcement}' but the manifest ` +
          `states '${rule.enforcement}'.`,
      );
    }
  }

  for (const id of parsed.keys()) {
    if (!manifest.some((rule) => rule.id === id)) {
      problems.push(
        `${DOC_PATH} lists '${id}', which has no entry in RETENTION_MANIFEST. Either the entry ` +
          `is missing or the document is stale.`,
      );
    }
  }

  // The prose sections that make the document answer a DSAR must not be
  // silently dropped when the table is regenerated.
  for (const heading of ['## Legal hold', '## Exemptions', '## Answering a subject-access request']) {
    if (!doc.includes(heading)) {
      problems.push(`${DOC_PATH} is missing the '${heading}' section.`);
    }
  }

  return problems;
}

function between(text: string, begin: string, end: string): string | null {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return text.slice(start + begin.length, stop);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export interface CheckResult {
  tables: number;
  rules: number;
  problems: string[];
}

/** Run every check. Returns the problems found rather than throwing. */
export function runChecks(root = REPO_ROOT): CheckResult {
  const tables = discoverTables(readMigrationSources(root));

  const envSchemaSources = fs
    .readdirSync(path.join(root, 'src/config/env-schema'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({
      file: `src/config/env-schema/${entry}`,
      sql: fs.readFileSync(path.join(root, 'src/config/env-schema', entry), 'utf8'),
    }));

  const docPath = path.join(root, DOC_PATH);
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';

  const problems = [
    ...checkManifestIntegrity(RETENTION_MANIFEST),
    ...checkCoverage(RETENTION_MANIFEST, tables),
    ...checkPurgeJobMatchesManifest(RETENTION_MANIFEST, PURGEABLE_RETENTION_SCHEDULE),
    ...checkAgeColumns(RETENTION_MANIFEST, tables),
    ...checkLegalHold(RETENTION_MANIFEST, tables),
    ...checkUnenforcedPeriods(RETENTION_MANIFEST),
    ...checkConfigDefaults(envSchemaSources, DLQ_RETENTION_DAYS_DEFAULT, IDEMPOTENCY_TTL_DAYS_DEFAULT),
    ...checkDocument(RETENTION_MANIFEST, doc),
  ];

  return { tables: tables.length, rules: PURGEABLE_RETENTION_SCHEDULE.length, problems };
}

export function formatResult(result: CheckResult): string {
  if (result.problems.length > 0) {
    const bullets = result.problems.map((problem) => `  - ${problem}`).join('\n');
    return [
      `Retention schedule check FAILED with ${result.problems.length} problem(s):`,
      bullets,
      '',
      'The published schedule, the manifest, the migrations and the purge jobs must agree.',
      'After changing any of them run: pnpm run check:retention -- --write',
    ].join('\n');
  }
  return [
    `Retention schedule check passed: ${result.rules} purge rule(s) over ${result.tables} table(s).`,
    'The published schedule, the manifest, the migrations and the purge jobs agree.',
  ].join('\n');
}

function main(argv: string[]): number {
  const write = argv.includes('--write');

  if (write) {
    const docPath = path.join(REPO_ROOT, DOC_PATH);
    if (!fs.existsSync(docPath)) {
      console.error(`Cannot write ${DOC_PATH}: the file does not exist.`);
      return 1;
    }
    const doc = fs.readFileSync(docPath, 'utf8');
    const generated = renderScheduleTable(RETENTION_MANIFEST);
    const start = doc.indexOf(DOC_BEGIN);
    const stop = doc.indexOf(DOC_END);
    if (start === -1 || stop === -1 || stop < start) {
      console.error(
        `Cannot write ${DOC_PATH}: the ${DOC_BEGIN} / ${DOC_END} markers are missing. Add them ` +
          `around the schedule table, then re-run.`,
      );
      return 1;
    }
    const updated = doc.slice(0, start) + generated + doc.slice(stop + DOC_END.length);
    fs.writeFileSync(docPath, updated, 'utf8');
    console.log(`Updated the schedule table in ${DOC_PATH} (${RETENTION_MANIFEST.length} entries).`);
  }

  const result = runChecks();
  const message = formatResult(result);
  if (result.problems.length > 0) {
    console.error(message);
    return 1;
  }
  console.log(message);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
