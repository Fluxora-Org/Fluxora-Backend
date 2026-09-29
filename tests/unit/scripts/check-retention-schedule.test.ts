/**
 * tests/unit/scripts/check-retention-schedule.test.ts
 *
 * Unit tests for the retention-schedule CI gate.
 *
 * Two jobs:
 *
 *  1. Prove the checks actually fire. A gate that cannot fail is worse than no
 *     gate, because it is trusted — so each negative case injects a specific
 *     regression (a table with no stated period, a window the job does not
 *     enforce, a hold on a table with no column) and asserts the check catches
 *     it.
 *  2. Assert the gate passes against the real repository, which is the
 *     property CI depends on: the shipped document, manifest, migrations and
 *     env schema already agree.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkCoverage,
  checkPurgeJobMatchesManifest,
  checkAgeColumns,
  checkLegalHold,
  checkUnenforcedPeriods,
  checkManifestIntegrity,
  checkConfigDefaults,
  checkDocument,
  discoverTables,
  readMigrationSources,
  renderScheduleTable,
  parseDocumentTable,
  runChecks,
  type DiscoveredTable,
} from '../../../scripts/check-retention-schedule.js';
import {
  RETENTION_MANIFEST,
  PURGEABLE_RETENTION_SCHEDULE,
  type DataRetentionRule,
} from '../../../src/pii/retention.js';
import { DataClassification } from '../../../src/pii/classification.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOC_PATH = path.join(REPO_ROOT, 'docs/retention-schedule.md');

/** A minimal valid manifest entry, overridable per test. */
function rule(overrides: Partial<DataRetentionRule> = {}): DataRetentionRule {
  return {
    id: 'example',
    dataClass: 'Example',
    table: 'example',
    storage: 'PostgreSQL — example',
    retentionDays: 30,
    ageColumn: 'created_at',
    purgeAction: 'delete',
    enforcement: 'retention-purge',
    enforcementRef: 'src/jobs/retentionPurge.ts',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    rationale: 'A sufficiently long justification for the example entry.',
    ...overrides,
  };
}

function table(name: string, columns: string[] = ['id', 'created_at']): DiscoveredTable {
  return {
    name,
    declaredIn: `migrations/${name}.ts`,
    columns: new Set(columns),
    isPartition: false,
  };
}

// ── Migration discovery ───────────────────────────────────────────────────────

describe('discoverTables', () => {
  it('finds node-pg-migrate createTable declarations with all their columns', () => {
    const found = discoverTables([
      {
        file: 'migrations/x.ts',
        sql: `pgm.createTable('webhook_dlq', {
  id:          { type: 'text', primaryKey: true },
  delivery_id: { type: 'text', notNull: true },
  created_at:  { type: 'timestamp with time zone', notNull: true },
});`,
      },
    ]);
    const dlq = found.find((t) => t.name === 'webhook_dlq');
    expect(dlq).toBeDefined();
    expect([...dlq!.columns].sort()).toEqual(['created_at', 'delivery_id', 'id']);
  });

  it('finds raw CREATE TABLE declarations', () => {
    const found = discoverTables([
      {
        file: 'migrations/y.ts',
        sql: `CREATE TABLE IF NOT EXISTS job_dead_letter (
      id BIGSERIAL PRIMARY KEY,
      job_name TEXT NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
      },
    ]);
    const jdl = found.find((t) => t.name === 'job_dead_letter');
    expect(jdl).toBeDefined();
    expect(jdl!.columns.has('failed_at')).toBe(true);
    expect(jdl!.columns.has('job_name')).toBe(true);
  });

  it('does not stop at the first column of a column list', () => {
    // The naive lazy-regex implementation captured only `id` here.
    const found = discoverTables([
      {
        file: 'migrations/z.ts',
        sql: `pgm.createTable('audit_logs', {
  id:        { type: 'bigserial', primaryKey: true },
  timestamp: { type: 'text', notNull: true },
  action:    { type: 'text', notNull: true },
});`,
      },
    ]);
    const audit = found.find((t) => t.name === 'audit_logs');
    expect(audit!.columns.has('timestamp')).toBe(true);
    expect(audit!.columns.has('action')).toBe(true);
  });

  it('merges columns added by a later migration', () => {
    // `streams` gains legal_hold in a migration that only ALTERs it.
    const found = discoverTables([
      { file: 'migrations/a.ts', sql: `pgm.createTable('streams', { id: { type: 'text' } });` },
      { file: 'migrations/b.ts', sql: `pgm.addColumn('streams', { legal_hold: { type: 'boolean' } });` },
    ]);
    const streams = found.find((t) => t.name === 'streams');
    expect(streams!.columns.has('id')).toBe(true);
    expect(streams!.columns.has('legal_hold')).toBe(true);
  });

  it('marks partition children and gives them no columns of their own', () => {
    const found = discoverTables([
      {
        file: 'migrations/p.ts',
        sql: `CREATE TABLE contract_events_default PARTITION OF contract_events DEFAULT
      FOR VALUES FROM (MINVALUE) TO (MAXVALUE);`,
      },
    ]);
    const child = found.find((t) => t.name === 'contract_events_default');
    expect(child?.isPartition).toBe(true);
  });
});

// ── Coverage ──────────────────────────────────────────────────────────────────

describe('checkCoverage', () => {
  it('accepts a manifest that covers every table', () => {
    expect(checkCoverage([rule()], [table('example')])).toEqual([]);
  });

  it('fails on a table with no stated retention period', () => {
    const problems = checkCoverage([rule()], [table('example'), table('brand_new_table')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/brand_new_table/);
    expect(problems[0]).toMatch(/RETENTION_MANIFEST/);
  });

  it('fails on a manifest entry naming a table no migration creates', () => {
    const problems = checkCoverage([rule({ table: 'does_not_exist' })], [table('example')]);
    expect(problems.join(' ')).toMatch(/does_not_exist/);
  });

  it('does not demand a migration for a non-database entry', () => {
    // Logs, backups and request metadata are persisted elsewhere, so a null
    // `table` must not be reported as a table no migration creates.
    const manifest = [rule({ id: 'db-entry' }), rule({ id: 'application-logs', table: null })];
    expect(checkCoverage(manifest, [table('example')])).toEqual([]);
  });

  it('allows a table to be covered by more than one data class', () => {
    // `streams` splits chain state from address PII with different periods.
    const problems = checkCoverage(
      [rule({ id: 'a' }), rule({ id: 'b', retentionDays: null, enforcement: 'none' })],
      [table('example')],
    );
    expect(problems).toEqual([]);
  });
});

// ── The job matches the manifest ──────────────────────────────────────────────

describe('checkPurgeJobMatchesManifest', () => {
  it('accepts the real manifest and the real derived schedule', () => {
    expect(checkPurgeJobMatchesManifest(RETENTION_MANIFEST, PURGEABLE_RETENTION_SCHEDULE)).toEqual([]);
  });

  it('fails when the job uses a different period than the manifest publishes', () => {
    const manifest = [rule({ retentionDays: 30 })];
    const schedule = [
      { category: 'Example', retentionDays: 90, table: 'example', ageColumn: 'created_at', purgeAction: 'delete' },
    ];
    const problems = checkPurgeJobMatchesManifest(manifest, schedule);
    expect(problems.join(' ')).toMatch(/30 day\(s\) but the purge job uses 90/);
  });

  it('fails when a manifest entry claims to be purged but has no rule', () => {
    const problems = checkPurgeJobMatchesManifest([rule()], []);
    expect(problems.join(' ')).toMatch(/no matching rule|rule\(s\)/);
  });

  it('fails when the job deletes a table the manifest says is retained', () => {
    const problems = checkPurgeJobMatchesManifest(
      [rule({ id: 'kept', enforcement: 'none', retentionDays: null, unenforcedReason: 'x' })],
      [
        { category: 'Kept', retentionDays: null, table: 'kept', ageColumn: 'created_at', purgeAction: 'delete' },
      ],
    );
    expect(problems.join(' ')).toMatch(/schedule says is retained/);
  });

  it('fails when the job ages rows by a different column', () => {
    const problems = checkPurgeJobMatchesManifest(
      [rule()],
      [
        { category: 'Example', retentionDays: 30, table: 'example', ageColumn: 'updated_at', purgeAction: 'delete' },
      ],
    );
    expect(problems.join(' ')).toMatch(/ages rows by 'created_at' but the purge job uses 'updated_at'/);
  });

  it('fails when the job redacts what the manifest says to delete', () => {
    const problems = checkPurgeJobMatchesManifest(
      [rule()],
      [
        { category: 'Example', retentionDays: 30, table: 'example', ageColumn: 'created_at', purgeAction: 'redact' },
      ],
    );
    expect(problems.join(' ')).toMatch(/purgeAction/);
  });
});

// ── Age columns ───────────────────────────────────────────────────────────────

describe('checkAgeColumns', () => {
  it('accepts a real column', () => {
    expect(checkAgeColumns([rule()], [table('example', ['id', 'created_at'])])).toEqual([]);
  });

  it('fails on a column the migration does not declare', () => {
    const problems = checkAgeColumns(
      [rule({ ageColumn: 'nope' })],
      [table('example', ['id', 'created_at'])],
    );
    expect(problems).toHaveLength(1);
  });

  it('says which columns do exist when it fails', () => {
    const problems = checkAgeColumns(
      [rule({ ageColumn: 'published_at' })],
      [table('example', ['id', 'created_at'])],
    );
    expect(problems.join(' ')).toMatch(/published_at/);
    expect(problems.join(' ')).toMatch(/Known columns: created_at, id/);
  });

  it('does not fail for a partition child, which declares no columns of its own', () => {
    const child: DiscoveredTable = {
      name: 'example_default',
      declaredIn: 'migrations/p.ts',
      columns: new Set(),
      isPartition: true,
    };
    expect(checkAgeColumns([rule({ table: 'example_default' })], [child])).toEqual([]);
  });

  it('ignores rules that are not enforced by the retention purge', () => {
    const entry = rule({ enforcement: 'none', ageColumn: 'not_a_column' });
    expect(checkAgeColumns([entry], [table('example', ['id'])])).toEqual([]);
  });
});

// ── Legal hold ────────────────────────────────────────────────────────────────

describe('checkLegalHold', () => {
  it('accepts an exemption on a table that has the column', () => {
    const entry = rule({ legalHoldExempt: true, table: 'streams' });
    // LEGAL_HOLD_EXEMPT_TABLES is fixed to ['streams'] in the real module.
    expect(checkLegalHold([entry], [table('streams', ['id', 'created_at', 'legal_hold'])])).toEqual([]);
  });

  it('fails on an exemption for a table with no legal_hold column', () => {
    const entry = rule({ legalHoldExempt: true, table: 'streams' });
    const problems = checkLegalHold([entry], [table('streams', ['id', 'created_at'])]);
    expect(problems.join(' ')).toMatch(/no 'legal_hold' column/);
  });

  it('fails on an exemption for a table that is not in LEGAL_HOLD_EXEMPT_TABLES', () => {
    // The real list holds only 'streams'; the column check passes, so the
    // remaining failure is the one under test.
    const entry = rule({ legalHoldExempt: true, table: 'not_exempt' });
    const problems = checkLegalHold([entry], [table('not_exempt', ['id', 'legal_hold'])]);
    expect(problems.join(' ')).toMatch(/not in LEGAL_HOLD_EXEMPT_TABLES/);
  });

  it('fails when a table is listed as hold-exempt but nothing claims it', () => {
    // `streams` is the only name in the real list.
    const problems = checkLegalHold([rule({ table: 'audit_logs' })], []);
    expect(problems.join(' ')).toMatch(/no manifest entry claims the exemption/);
  });
});

// ── Gaps, integrity, config ───────────────────────────────────────────────────

describe('checkUnenforcedPeriods', () => {
  it('rejects a positive period nothing enforces and does not explain', () => {
    expect(checkUnenforcedPeriods([rule({ enforcement: 'none' })]).join(' ')).toMatch(
      /unenforcedReason/,
    );
  });

  it('accepts that same entry once the reason is written', () => {
    expect(
      checkUnenforcedPeriods([rule({ enforcement: 'none', unenforcedReason: 'Predicate pending.' })]),
    ).toEqual([]);
  });

  it('rejects an unenforced reason on a rule that is enforced', () => {
    expect(
      checkUnenforcedPeriods([rule({ enforcement: 'retention-purge', unenforcedReason: 'stale' })]).join(' '),
    ).toMatch(/does not exist/);
  });

  it('rejects a negative period', () => {
    expect(checkUnenforcedPeriods([rule({ retentionDays: -1 })]).join(' ')).toMatch(/negative/);
  });

  it('rejects an empty rationale', () => {
    expect(checkUnenforcedPeriods([rule({ rationale: '  ' })]).join(' ')).toMatch(/empty rationale/);
  });
});

describe('checkManifestIntegrity', () => {
  it('accepts the real manifest', () => {
    expect(checkManifestIntegrity(RETENTION_MANIFEST)).toEqual([]);
  });

  it('rejects a duplicate id', () => {
    expect(checkManifestIntegrity([rule(), rule()]).join(' ')).toMatch(/Duplicate manifest id/);
  });

  it('rejects a non-kebab-case id, because ids are published and cross-referenced', () => {
    expect(checkManifestIntegrity([rule({ id: 'Not_Kebab' })]).join(' ')).toMatch(/kebab-case/);
  });

  it('rejects a missing enforcementRef', () => {
    expect(
      checkManifestIntegrity([rule({ enforcementRef: '' })]).join(' '),
    ).toMatch(/enforcementRef/);
  });
});

describe('checkConfigDefaults', () => {
  const schema = (dlq: string, ttl: string) => [
    { file: 'infrastructure.ts', sql: `DLQ_RETENTION_DAYS: integerEnv('DLQ_RETENTION_DAYS', 1, 365).default(${dlq})` },
    { file: 'infrastructure.ts', sql: `IDEMPOTENCY_TTL_SECONDS: integerEnv('IDEMPOTENCY_TTL_SECONDS', 60, 604800).default(${ttl})` },
  ];

  it('accepts matching defaults', () => {
    expect(checkConfigDefaults(schema('30', '86400'), 30, 1)).toEqual([]);
  });

  it('fails when the DLQ default drifts from the manifest', () => {
    expect(checkConfigDefaults(schema('90', '86400'), 30, 1).join(' ')).toMatch(
      /DLQ_RETENTION_DAYS with a default of 90/,
    );
  });

  it('fails when the idempotency TTL drifts from the manifest', () => {
    expect(checkConfigDefaults(schema('30', '172800'), 30, 1).join(' ')).toMatch(
      /IDEMPOTENCY_TTL_SECONDS/,
    );
  });

  it('fails when the variable cannot be found at all', () => {
    expect(checkConfigDefaults([{ file: 'x.ts', sql: '// nothing here' }], 30, 1)).toHaveLength(2);
  });
});

// ── The document ──────────────────────────────────────────────────────────────

describe('document consistency', () => {
  it('renders and re-parses a table that matches the manifest', () => {
    const rendered = renderScheduleTable(RETENTION_MANIFEST);
    const parsed = parseDocumentTable(rendered);
    expect(parsed.size).toBe(RETENTION_MANIFEST.length);
    expect([...parsed.keys()].sort()).toEqual(RETENTION_MANIFEST.map((r) => r.id).sort());
  });

  it('keeps two entries for the same table distinct, by id', () => {
    // `streams` appears twice: address PII (365 days) and chain state
    // (indefinite). Keying the table by table name would collapse them.
    const rendered = renderScheduleTable(RETENTION_MANIFEST);
    const parsed = parseDocumentTable(rendered);
    expect(parsed.get('streams-pii')?.period).toBe('365 days');
    expect(parsed.get('streams-chain-state')?.period).toBe('indefinite');
  });

  it('fails when the document states a different period than the manifest', () => {
    const doc = renderScheduleTable(RETENTION_MANIFEST).replace('| 365 days |', '| 730 days |');
    const problems = checkDocument(RETENTION_MANIFEST, doc);
    expect(problems.join(' ')).toMatch(/states '365 days'|states '730 days'/);
  });

  it('fails when the document states a different enforcement mechanism', () => {
    const doc = renderScheduleTable(RETENTION_MANIFEST).replace('| retention-purge |', '| none |');
    expect(checkDocument(RETENTION_MANIFEST, doc).join(' ')).toMatch(/enforcement/);
  });

  it('fails when the document is missing the generated markers', () => {
    const problems = checkDocument(RETENTION_MANIFEST, '# Retention\n\nNo table here.');
    expect(problems.join(' ')).toMatch(/markers/);
  });

  it('fails when the document omits a data class', () => {
    const manifest = [rule({ id: 'a' }), rule({ id: 'b', table: 'other' })];
    const doc = `# Retention

<!-- retention-schedule:begin -->
| ID | Data class | Table | Retention | Action | Enforced by | Legal hold |
| --- | --- | --- | --- | --- | --- | --- |
| \`a\` | Example | \`example\` | 30 days | delete | retention-purge | no |
<!-- retention-schedule:end -->

## Legal hold
## Exemptions
## Answering a subject-access request
`;
    expect(checkDocument(manifest, doc).join(' ')).toMatch(/does not list 'b'/);
  });

  it('fails when a required prose section is missing', () => {
    const doc = renderScheduleTable(RETENTION_MANIFEST);
    const problems = checkDocument(RETENTION_MANIFEST, doc);
    expect(problems.join(' ')).toMatch(/missing the '## Legal hold' section/);
  });
});

// ── The gate, against the real repository ─────────────────────────────────────

describe('the shipped repository satisfies the gate', () => {
  it('discovers the tables the migrations create', () => {
    const tables = discoverTables(readMigrationSources(REPO_ROOT)).map((t) => t.name);
    // A representative sample, so a discovery regression is caught here rather
    // than by the gate silently covering fewer tables than it used to.
    for (const expected of [
      'streams',
      'audit_logs',
      'contract_events',
      'webhook_outbox',
      'webhook_dlq',
      'dead_letter_queue',
      'privacy_consents',
      'api_keys',
      'job_dead_letter',
      'tenant_rate_limit_overrides',
    ]) {
      expect(tables, `expected to discover '${expected}'`).toContain(expected);
    }
  });

  it('publishes the document the gate reads', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    expect(doc).toMatch(/## Legal hold/);
    expect(doc).toMatch(/## Exemptions/);
    expect(doc).toMatch(/## Answering a subject-access request/);
  });

  it('reports no problems', () => {
    const result = runChecks(REPO_ROOT);
    expect(result.problems).toEqual([]);
    expect(result.rules).toBeGreaterThan(0);
    expect(result.tables).toBeGreaterThan(0);
  });
});
