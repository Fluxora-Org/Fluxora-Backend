#!/usr/bin/env node

/**
 * Produce a dry-run report for the pgmigrations rename. This never writes to
 * PostgreSQL. It gives operators an explicit answer to the important rollout
 * question: did an environment record the old stem before the file changed?
 */

import process from 'node:process';

export const OLD_PGCRYPTO_STEM = '20260601_enable_pgcrypto_encrypt_addresses';
export const NEW_PGCRYPTO_STEM = '1787788800000_enable_pgcrypto_encrypt_addresses';

export class LedgerAuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LedgerAuditError';
    this.code = code;
    Object.assign(this, details);
  }
}

function unique(values) {
  return [...new Set(values)];
}

export function auditLedger(appliedNames, onDiskNames, {
  oldStem = OLD_PGCRYPTO_STEM,
  newStem = NEW_PGCRYPTO_STEM,
} = {}) {
  if (!Array.isArray(appliedNames) || !Array.isArray(onDiskNames)) {
    throw new LedgerAuditError('INPUT_INVALID', 'Applied and on-disk migration names must be arrays.');
  }
  const duplicateApplied = appliedNames.filter((name, index) => appliedNames.indexOf(name) !== index);
  if (duplicateApplied.length) throw new LedgerAuditError('APPLIED_DUPLICATE', `Applied ledger contains duplicate names: ${unique(duplicateApplied).join(', ')}`);
  if (!onDiskNames.includes(newStem)) throw new LedgerAuditError('NEW_STEM_MISSING', `On-disk migrations do not contain ${newStem}.`, { newStem });
  const oldApplied = appliedNames.includes(oldStem);
  const newApplied = appliedNames.includes(newStem);
  const oldOnDisk = onDiskNames.includes(oldStem);
  if (oldApplied && newApplied) throw new LedgerAuditError('BOTH_STEMS_APPLIED', 'Both old and new pgcrypto stems are recorded; stop and inspect before migrating.');
  if (oldOnDisk) throw new LedgerAuditError('OLD_STEM_ON_DISK', 'The old pgcrypto stem is still present on disk.');
  const pending = onDiskNames.filter((name) => !appliedNames.includes(name));
  return {
    oldApplied,
    newApplied,
    action: oldApplied ? 'RECONCILE_OLD_STEM_BEFORE_RUN' : 'RUN_NEW_STEM',
    pending,
    requiresOperatorReview: oldApplied,
    safeToRunNewStem: !oldApplied && !newApplied,
    oldStem,
    newStem,
  };
}

export function renderAudit(result) {
  const lines = [
    `Ledger audit: ${result.action}.`,
    `old stem applied=${result.oldApplied}; new stem applied=${result.newApplied}.`,
    `pending migrations=${result.pending.length}.`,
  ];
  if (result.requiresOperatorReview) lines.push('Operator review is required before applying the renamed migration.');
  return lines.join('\n');
}

export function main() {
  console.error('Pass explicit ledger data to auditLedger from an operator script; no database writes are performed.');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
