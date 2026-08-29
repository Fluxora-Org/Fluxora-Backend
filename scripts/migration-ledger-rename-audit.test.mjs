import { describe, expect, it } from 'vitest';
import { LedgerAuditError, NEW_PGCRYPTO_STEM, OLD_PGCRYPTO_STEM, auditLedger, renderAudit } from './migration-ledger-rename-audit.mjs';

const current = ['1000000000000_initial_schema', '1774715131962_streams-table', NEW_PGCRYPTO_STEM];

describe('migration ledger rename audit', () => {
  it('allows a fresh database to run the new stem', () => {
    const result = auditLedger([], current);
    expect(result).toMatchObject({ action: 'RUN_NEW_STEM', safeToRunNewStem: true, requiresOperatorReview: false });
    expect(result.pending).toEqual(current);
  });
  it('requires review when the old stem was already applied', () => {
    const result = auditLedger([OLD_PGCRYPTO_STEM], current);
    expect(result.action).toBe('RECONCILE_OLD_STEM_BEFORE_RUN');
    expect(result.requiresOperatorReview).toBe(true);
    expect(result.safeToRunNewStem).toBe(false);
    expect(renderAudit(result)).toContain('Operator review');
  });
  it('does not treat an already applied new stem as pending', () => {
    const result = auditLedger([NEW_PGCRYPTO_STEM], current);
    expect(result.newApplied).toBe(true);
    expect(result.pending).not.toContain(NEW_PGCRYPTO_STEM);
  });
  it('rejects a missing new stem', () => expect(() => auditLedger([], ['other'])).toThrow(/do not contain/));
  it('rejects the old stem still on disk', () => expect(() => auditLedger([], [...current, OLD_PGCRYPTO_STEM])).toThrow(/still present/));
  it('rejects both stems recorded', () => expect(() => auditLedger([OLD_PGCRYPTO_STEM, NEW_PGCRYPTO_STEM], current)).toThrow(/Both old and new/));
  it('rejects duplicate ledger rows', () => expect(() => auditLedger([NEW_PGCRYPTO_STEM, NEW_PGCRYPTO_STEM], current)).toThrow(LedgerAuditError));
  it('rejects non-array input', () => expect(() => auditLedger(null, current)).toThrow(/must be arrays/));
  it('reports unrelated pending migrations', () => {
    const result = auditLedger([], [...current, '1787788800001_next_change']);
    expect(result.pending).toContain('1787788800001_next_change');
    expect(renderAudit(result)).toContain('pending migrations=4');
  });
  it('supports explicit stem names for reusable tooling', () => {
    const result = auditLedger([], ['new-target'], { oldStem: 'old-target', newStem: 'new-target' });
    expect(result.newStem).toBe('new-target');
  });
  it('reports the old and new names in the result', () => {
    const result = auditLedger([OLD_PGCRYPTO_STEM], current);
    expect(result.oldStem).toBe(OLD_PGCRYPTO_STEM);
    expect(result.newStem).toBe(NEW_PGCRYPTO_STEM);
  });
  it('keeps an empty applied ledger deterministic', () => {
    expect(auditLedger([], current).oldApplied).toBe(false);
    expect(auditLedger([], current).oldApplied).toBe(false);
  });
  it('keeps an operator report free of SQL or credentials', () => {
    expect(renderAudit(auditLedger([], current))).not.toMatch(/password|secret|SELECT|UPDATE/i);
  });
  it.each([
    [[], 'RUN_NEW_STEM'],
    [[NEW_PGCRYPTO_STEM], 'RUN_NEW_STEM'],
    [[OLD_PGCRYPTO_STEM], 'RECONCILE_OLD_STEM_BEFORE_RUN'],
  ])('selects deterministic action for applied state %p', (applied, action) => {
    expect(auditLedger(applied, current).action).toBe(action);
  });
  it('lists only unapplied names', () => {
    const result = auditLedger(['1000000000000_initial_schema'], current);
    expect(result.pending).not.toContain('1000000000000_initial_schema');
    expect(result.pending).toContain(NEW_PGCRYPTO_STEM);
  });
  it('does not confuse a similar old stem with the exact target', () => {
    const result = auditLedger([], [...current, '20260601_enable_pgcrypto_encrypt_addresses_copy']);
    expect(result.action).toBe('RUN_NEW_STEM');
  });
  it('handles empty on-disk history as a clear error', () => {
    expect(() => auditLedger([], [])).toThrow(LedgerAuditError);
  });
  it('preserves caller arrays', () => {
    const applied = [OLD_PGCRYPTO_STEM];
    const onDisk = [...current];
    auditLedger(applied, onDisk);
    expect(applied).toEqual([OLD_PGCRYPTO_STEM]);
    expect(onDisk).toEqual(current);
  });
  it('supports a custom migration rollout pair', () => {
    const result = auditLedger(['old'], ['new'], { oldStem: 'old', newStem: 'new' });
    expect(result.action).toBe('RECONCILE_OLD_STEM_BEFORE_RUN');
  });
  it('requires review for a custom old stem', () => {
    const result = auditLedger(['old'], ['new'], { oldStem: 'old', newStem: 'new' });
    expect(result.requiresOperatorReview).toBe(true);
  });
  it('reports zero pending work after all current names apply', () => {
    expect(auditLedger(current, current).pending).toEqual([]);
  });
  it('does not emit a remediation command that could be copied blindly', () => {
    expect(renderAudit(auditLedger([OLD_PGCRYPTO_STEM], current))).not.toMatch(/DROP|DELETE|UPDATE/);
  });
  it('makes old-stem review visible even with unrelated pending work', () => {
    const result = auditLedger([OLD_PGCRYPTO_STEM], [...current, '1787788800001_next']);
    expect(result.requiresOperatorReview).toBe(true);
    expect(result.pending).toContain('1787788800001_next');
  });
  it('rejects duplicate applied names before evaluating migration state', () => {
    expect(() => auditLedger(['x', 'x'], current)).toThrow(/duplicate names/);
  });
  it('rejects malformed applied input consistently', () => {
    for (const value of [undefined, {}, 'name']) expect(() => auditLedger(value, current)).toThrow('must be arrays');
  });
  it('rejects malformed disk input consistently', () => {
    for (const value of [undefined, {}, 'name']) expect(() => auditLedger([], value)).toThrow('must be arrays');
  });
  it('includes pending count in a fresh report', () => {
    expect(renderAudit(auditLedger([], current))).toContain(`pending migrations=${current.length}`);
  });
  it('includes pending count after one applied migration', () => {
    expect(renderAudit(auditLedger([current[0]], current))).toContain(`pending migrations=${current.length - 1}`);
  });
  it('uses exact equality for old stem matching', () => {
    const result = auditLedger([], [...current, `${OLD_PGCRYPTO_STEM}-copy`]);
    expect(result.oldApplied).toBe(false);
  });
  it('keeps the new stem safe when old is absent', () => {
    expect(auditLedger([], current).safeToRunNewStem).toBe(true);
  });
  it('marks an already applied new stem as not safe to rerun', () => {
    expect(auditLedger([NEW_PGCRYPTO_STEM], current).safeToRunNewStem).toBe(false);
  });
});
