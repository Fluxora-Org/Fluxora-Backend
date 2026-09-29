/**
 * tests/pii/retentionManifest.test.ts
 *
 * The retention manifest is the single source of truth for how long the
 * service keeps each class of persisted data, and the purge job's rule list is
 * derived from it. These tests assert the properties that make that
 * trustworthy — coverage, internal consistency, and the fact that the
 * derivation really is a derivation.
 *
 * The cross-file consistency checks (document vs. manifest vs. migrations vs.
 * env schema) live in `tests/unit/scripts/check-retention-schedule.test.ts`,
 * which is the same code CI runs.
 */

import { describe, it, expect } from 'vitest';
import {
  RETENTION_MANIFEST,
  PURGEABLE_RETENTION_SCHEDULE,
  LEGAL_HOLD_EXEMPT_TABLES,
  LEGAL_HOLD_POLICY,
  publishedRetentionRules,
  DLQ_RETENTION_DAYS_DEFAULT,
  type DataRetentionRule,
} from '../../src/pii/retention.js';
import { DataClassification } from '../../src/pii/classification.js';
import { RETENTION_SCHEDULE } from '../../src/pii/policy.js';
import {
  checkUnenforcedPeriods,
  discoverTables,
  readMigrationSources,
} from '../../scripts/check-retention-schedule.js';

const purgeable = RETENTION_MANIFEST.filter((rule) => rule.enforcement === 'retention-purge');

describe('RETENTION_MANIFEST — coverage', () => {
  it('is not empty', () => {
    expect(RETENTION_MANIFEST.length).toBeGreaterThan(0);
  });

  it('gives every entry a unique, stable, kebab-case id', () => {
    const ids = RETENTION_MANIFEST.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, `id '${id}' must be kebab-case`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('states a period for every data class', () => {
    for (const rule of RETENTION_MANIFEST) {
      const hasPeriod = rule.retentionDays === null || Number.isFinite(rule.retentionDays);
      expect(hasPeriod, `'${rule.id}' has no usable retentionDays`).toBe(true);
      if (rule.retentionDays !== null) {
        expect(rule.retentionDays, `'${rule.id}' has a negative period`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('justifies every period', () => {
    for (const rule of RETENTION_MANIFEST) {
      expect(rule.rationale.trim().length, `'${rule.id}' has no rationale`).toBeGreaterThan(20);
    }
  });

  it('names what enforces every period', () => {
    for (const rule of RETENTION_MANIFEST) {
      expect(rule.enforcementRef.trim().length, `'${rule.id}' names no enforcementRef`).toBeGreaterThan(0);
    }
  });

  it('covers every table the migrations create', () => {
    const tables = discoverTables(readMigrationSources());
    const declared = new Set(RETENTION_MANIFEST.map((rule) => rule.table).filter(Boolean));

    for (const table of tables) {
      expect(declared.has(table.name), `table '${table.name}' has no manifest entry`).toBe(true);
    }
  });

  it('names only tables the migrations create', () => {
    const tables = new Set(discoverTables(readMigrationSources()).map((table) => table.name));

    for (const rule of RETENTION_MANIFEST) {
      if (rule.table === null) continue;
      expect(tables.has(rule.table), `'${rule.id}' names unknown table '${rule.table}'`).toBe(true);
    }
  });
});

describe('RETENTION_MANIFEST — no silent gaps', () => {
  it('requires a written reason for a positive period nothing enforces', () => {
    for (const rule of RETENTION_MANIFEST) {
      const promisesDeletion =
        rule.retentionDays !== null && rule.retentionDays > 0 && rule.enforcement === 'none';
      if (!promisesDeletion) continue;
      expect(
        (rule.unenforcedReason ?? '').trim().length,
        `'${rule.id}' promises a ${rule.retentionDays}-day period with nothing enforcing it`,
      ).toBeGreaterThan(0);
    }
  });

  it('publishes every unenforced reason in the endpoint projection', () => {
    const published = publishedRetentionRules();
    for (const rule of RETENTION_MANIFEST) {
      if (!rule.unenforcedReason) continue;
      const entry = published.find((candidate) => candidate.id === rule.id);
      expect(entry?.unenforcedReason, `'${rule.id}' reason is not published`).toBe(
        rule.unenforcedReason,
      );
    }
  });

  it('does not attach an unenforced reason to a rule that is enforced', () => {
    for (const rule of RETENTION_MANIFEST) {
      if (rule.enforcement === 'none') continue;
      expect(rule.unenforcedReason, `'${rule.id}' is enforced but claims a gap`).toBeUndefined();
    }
  });
});

describe('PURGEABLE_RETENTION_SCHEDULE — derived from the manifest', () => {
  it('contains exactly the entries declared purgeable', () => {
    expect(PURGEABLE_RETENTION_SCHEDULE).toHaveLength(purgeable.length);
    for (const rule of purgeable) {
      expect(
        PURGEABLE_RETENTION_SCHEDULE.some((candidate) => candidate.table === rule.table),
        `'${rule.id}' is declared purgeable but has no purge rule`,
      ).toBe(true);
    }
  });

  it('carries the same period, age column and action as the manifest', () => {
    for (const rule of purgeable) {
      const match = PURGEABLE_RETENTION_SCHEDULE.find((c) => c.table === rule.table);
      expect(match, `no rule for '${rule.id}'`).toBeDefined();
      expect(match!.retentionDays, `'${rule.id}' period`).toBe(rule.retentionDays);
      expect(match!.ageColumn, `'${rule.id}' age column`).toBe(rule.ageColumn);
      expect(
        match!.purgeAction,
        `'${rule.id}' purge action (the job only implements delete and redact)`,
      ).toBe(rule.purgeAction === 'redact' ? 'redact' : 'delete');
    }
  });

  it('only emits purge actions the job actually implements', () => {
    // `runRetentionPurge`'s `purgeRow` throws for any third verb, so a rule with
    // an action outside {delete, redact} would crash the job at runtime.
    for (const rule of PURGEABLE_RETENTION_SCHEDULE) {
      expect(['delete', 'redact']).toContain(rule.purgeAction);
    }
  });

  it('excludes rules with no table or age column', () => {
    for (const rule of PURGEABLE_RETENTION_SCHEDULE) {
      expect(rule.table).toBeTruthy();
      expect(rule.ageColumn).toBeTruthy();
    }
  });

  it('never targets a table twice', () => {
    const tables = PURGEABLE_RETENTION_SCHEDULE.map((rule) => rule.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('purges the tables the schedule says are purged', () => {
    // The regression this pins: the tables that were silently accumulating with
    // no enforcement at all.
    const tables = PURGEABLE_RETENTION_SCHEDULE.map((rule) => rule.table);
    expect(tables).toContain('webhook_dlq');
    expect(tables).toContain('job_dead_letter');
    expect(tables).toContain('tenant_rate_limit_overrides');
    // And the pre-existing ones must still be enforced.
    expect(tables).toContain('audit_logs');
    expect(tables).toContain('streams');
    expect(tables).toContain('webhook_outbox');
  });
});

describe('legal hold', () => {
  it('only exempts tables that really have the column', () => {
    expect([...LEGAL_HOLD_EXEMPT_TABLES]).toEqual(['streams']);
  });

  it('agrees with the manifest about which classes are exempt', () => {
    for (const rule of RETENTION_MANIFEST) {
      if (!rule.legalHoldExempt) continue;
      expect(LEGAL_HOLD_EXEMPT_TABLES, `'${rule.id}' claims an exemption`).toContain(rule.table);
    }
  });

  it('describes the column, the release path and the non-exempt case', () => {
    expect(LEGAL_HOLD_POLICY.column).toBe('legal_hold');
    expect(LEGAL_HOLD_POLICY.exemptTables).toEqual([...LEGAL_HOLD_EXEMPT_TABLES]);
    // A hold covering anything else is not silently ignored: the policy has to
    // say it cannot be honoured there.
    expect(LEGAL_HOLD_POLICY.nonExemptNote).toMatch(
      /has to be implemented at that table before it can be honoured/,
    );
    expect(LEGAL_HOLD_POLICY.enforcement).toMatch(/PURGE_SKIPPED_LEGAL_HOLD/);
    expect(LEGAL_HOLD_POLICY.release).toMatch(/clear legal_hold/);
  });
});

describe('published projection', () => {
  it('is what the privacy endpoint serves', () => {
    expect(RETENTION_SCHEDULE).toEqual(publishedRetentionRules());
  });

  it('keeps the historical field names consumers already read', () => {
    for (const rule of RETENTION_SCHEDULE) {
      expect(typeof rule.category).toBe('string');
      expect(rule.retentionDays === null || typeof rule.retentionDays === 'number').toBe(true);
      expect(typeof rule.storageLayer).toBe('string');
      expect(typeof rule.rationale).toBe('string');
    }
  });

  it('adds the enforcement metadata a subject-access response needs', () => {
    for (const rule of RETENTION_SCHEDULE) {
      expect(typeof rule.id).toBe('string');
      expect(typeof rule.enforcement).toBe('string');
      expect(typeof rule.purgeAction).toBe('string');
      expect(typeof rule.legalHoldExempt).toBe('boolean');
      expect(typeof rule.classification).toBe('string');
    }
  });

  it('covers every manifest entry', () => {
    expect(RETENTION_SCHEDULE).toHaveLength(RETENTION_MANIFEST.length);
  });
});

describe('configurable windows', () => {
  it('records the DLQ default the env schema ships', () => {
    expect(DLQ_RETENTION_DAYS_DEFAULT).toBe(30);
  });

  it('records the DLQ window as a positive, finite number of days', () => {
    const dlq = RETENTION_MANIFEST.find((rule) => rule.enforcement === 'dlq-purge');
    expect(dlq?.retentionDays).toBe(DLQ_RETENTION_DAYS_DEFAULT);
  });
});

describe('a finite period is only claimed where something can honour it', () => {
  const rule = (overrides: Partial<DataRetentionRule>): DataRetentionRule => ({
    id: 'example',
    dataClass: 'Example',
    table: null,
    storage: 'process memory',
    retentionDays: 30,
    purgeAction: 'none',
    enforcement: 'none',
    enforcementRef: 'none',
    legalHoldExempt: false,
    classification: DataClassification.INTERNAL,
    rationale: 'An example entry used to exercise the manifest invariants.',
    ...overrides,
  });

  it('accepts an indefinite period with no enforcement', () => {
    expect(checkUnenforcedPeriods([rule({ retentionDays: null })])).toEqual([]);
  });

  it('accepts zero days with no enforcement (the data is never persisted)', () => {
    expect(checkUnenforcedPeriods([rule({ retentionDays: 0 })])).toEqual([]);
  });

  it('rejects a positive period with no enforcement and no reason', () => {
    const problems = checkUnenforcedPeriods([rule({ retentionDays: 30 })]);
    expect(problems.join(' ')).toMatch(/unenforcedReason/);
  });

  it('accepts a positive period once the reason is written down', () => {
    expect(
      checkUnenforcedPeriods([
        rule({ retentionDays: 30, unenforcedReason: 'The predicate is not implemented yet.' }),
      ]),
    ).toEqual([]);
  });
});
