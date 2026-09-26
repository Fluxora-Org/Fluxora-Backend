#!/usr/bin/env node

/**
 * Enforcing security audit with exception management
 *
 * This script:
 * 1. Runs `pnpm audit --audit-level=moderate --json`
 * 2. Parses findings at moderate/high/critical severity
 * 3. Checks each finding against `.audit-exceptions.json`
 * 4. Validates that exceptions have not expired
 * 5. Fails with exit code 1 if any finding is not covered by a valid exception
 *
 * Exit codes:
 * - 0: No unexcepted vulnerabilities found
 * - 1: Unexcepted vulnerabilities or expired exceptions found
 * - 2: Configuration or runtime error
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const EXCEPTIONS_PATH = resolve(process.cwd(), '.audit-exceptions.json');
const SEVERITY_ORDER = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
const MIN_SEVERITY = 'moderate';

// Remediation windows in days
const REMEDIATION_WINDOWS = {
  critical: 7,
  high: 14,
  moderate: 30,
};

/**
 * Load and validate exceptions file
 */
function loadExceptions() {
  try {
    const raw = readFileSync(EXCEPTIONS_PATH, 'utf-8');
    const data = JSON.parse(raw);

    if (!data.exceptions || !Array.isArray(data.exceptions)) {
      throw new Error('Invalid format: "exceptions" must be an array');
    }

    // Validate each exception
    for (const ex of data.exceptions) {
      if (!ex.name || typeof ex.name !== 'string') {
        throw new Error(`Exception missing or invalid "name": ${JSON.stringify(ex)}`);
      }
      if (!ex.reason || typeof ex.reason !== 'string') {
        throw new Error(`Exception "${ex.name}" missing or invalid "reason"`);
      }
      if (!ex.severity || !['critical', 'high', 'moderate'].includes(ex.severity)) {
        throw new Error(`Exception "${ex.name}" has invalid "severity": ${ex.severity}`);
      }
      if (!ex.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(ex.expiry)) {
        throw new Error(`Exception "${ex.name}" has invalid "expiry" date format (expected YYYY-MM-DD)`);
      }
      if (!ex.approvedBy || typeof ex.approvedBy !== 'string') {
        throw new Error(`Exception "${ex.name}" missing or invalid "approvedBy"`);
      }
      if (!ex.createdAt || !/^\d{4}-\d{2}-\d{2}$/.test(ex.createdAt)) {
        throw new Error(`Exception "${ex.name}" has invalid "createdAt" date format (expected YYYY-MM-DD)`);
      }
    }

    return data.exceptions;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`No exceptions file found at ${EXCEPTIONS_PATH}. Proceeding with strict audit.`);
      return [];
    }
    console.error(`Failed to load exceptions: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Check if an exception has expired
 */
function isExpired(expiryDate) {
  const expiry = new Date(expiryDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return expiry < today;
}

/**
 * Check if an exception is nearing expiry (within 7 days)
 */
function isNearingExpiry(expiryDate) {
  const expiry = new Date(expiryDate);
  const today = new Date();
  const sevenDaysFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  return expiry >= today && expiry <= sevenDaysFromNow;
}

/**
 * Run pnpm audit and parse output
 */
function runAudit() {
  try {
    execSync('pnpm audit --audit-level=moderate --json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // If audit succeeds with exit code 0, there are no vulnerabilities
    return { advisories: {}, metadata: { vulnerabilities: {} } };
  } catch (err) {
    if (!err.stdout) {
      console.error('Failed to run pnpm audit. Ensure pnpm is installed.');
      process.exit(2);
    }

    try {
      const output = JSON.parse(err.stdout);
      return output;
    } catch (parseErr) {
      console.error('Failed to parse pnpm audit output as JSON.');
      console.error(err.stdout);
      process.exit(2);
    }
  }
}

/**
 * Extract vulnerability findings at or above the minimum severity
 */
function extractFindings(auditOutput) {
  const findings = [];

  if (!auditOutput.advisories) {
    return findings;
  }

  for (const [id, advisory] of Object.entries(auditOutput.advisories)) {
    const severity = advisory.severity?.toLowerCase();
    if (SEVERITY_ORDER[severity] >= SEVERITY_ORDER[MIN_SEVERITY]) {
      findings.push({
        id,
        name: advisory.module_name || advisory.name || 'unknown',
        severity,
        title: advisory.title || 'No title',
        url: advisory.url || '',
        findings: advisory.findings || [],
      });
    }
  }

  return findings;
}

/**
 * Check findings against exceptions
 */
function checkFindings(findings, exceptions) {
  const unexcepted = [];
  const expired = [];
  const nearingExpiry = [];

  // Build a map of exceptions by package name
  const exceptionMap = new Map();
  for (const ex of exceptions) {
    exceptionMap.set(ex.name, ex);
  }

  // Check for expired exceptions
  for (const ex of exceptions) {
    if (isExpired(ex.expiry)) {
      expired.push(ex);
    } else if (isNearingExpiry(ex.expiry)) {
      nearingExpiry.push(ex);
    }
  }

  // Check each finding
  for (const finding of findings) {
    const exception = exceptionMap.get(finding.name);

    if (!exception) {
      unexcepted.push(finding);
    } else if (isExpired(exception.expiry)) {
      // Already tracked in expired array, but also flag the finding
      unexcepted.push({
        ...finding,
        expiredExceptionDate: exception.expiry,
      });
    }
  }

  return { unexcepted, expired, nearingExpiry };
}

/**
 * Validate exceptions file format only (--validate flag)
 */
function validateOnly() {
  console.log('Validating exceptions file...');
  const exceptions = loadExceptions();
  console.log(`✓ Exceptions file is valid (${exceptions.length} exceptions found)`);

  const expired = exceptions.filter((ex) => isExpired(ex.expiry));
  const nearingExpiry = exceptions.filter((ex) => isNearingExpiry(ex.expiry));

  if (expired.length > 0) {
    console.warn(`\n⚠ Warning: ${expired.length} exception(s) have expired:`);
    expired.forEach((ex) => {
      console.warn(`  - ${ex.name} (expired ${ex.expiry})`);
    });
  }

  if (nearingExpiry.length > 0) {
    console.log(`\n⚠ Notice: ${nearingExpiry.length} exception(s) expiring within 7 days:`);
    nearingExpiry.forEach((ex) => {
      console.log(`  - ${ex.name} (expires ${ex.expiry})`);
    });
  }

  process.exit(0);
}

/**
 * Main execution
 */
function main() {
  // Check for --validate flag
  if (process.argv.includes('--validate')) {
    validateOnly();
    return;
  }

  console.log('Running enforcing security audit...\n');

  const exceptions = loadExceptions();
  console.log(`Loaded ${exceptions.length} exception(s) from ${EXCEPTIONS_PATH}\n`);

  console.log('Running pnpm audit...');
  const auditOutput = runAudit();

  const findings = extractFindings(auditOutput);
  console.log(`Found ${findings.length} vulnerability finding(s) at moderate+ severity\n`);

  if (findings.length === 0) {
    console.log('✓ No vulnerabilities found at moderate or above severity.');
    process.exit(0);
  }

  const { unexcepted, expired, nearingExpiry } = checkFindings(findings, exceptions);

  // Report expired exceptions
  if (expired.length > 0) {
    console.error(`\n❌ EXPIRED EXCEPTIONS (${expired.length}):`);
    console.error('The following exceptions have expired and must be remediated or renewed:\n');
    expired.forEach((ex) => {
      console.error(`  Package: ${ex.name}`);
      console.error(`  Severity: ${ex.severity}`);
      console.error(`  Expired: ${ex.expiry}`);
      console.error(`  Reason: ${ex.reason}`);
      console.error(`  Approved by: ${ex.approvedBy}\n`);
    });
  }

  // Report nearing expiry
  if (nearingExpiry.length > 0) {
    console.warn(`⚠ EXCEPTIONS NEARING EXPIRY (${nearingExpiry.length}):`);
    nearingExpiry.forEach((ex) => {
      console.warn(`  - ${ex.name} expires ${ex.expiry}`);
    });
    console.warn('');
  }

  // Report unexcepted vulnerabilities
  if (unexcepted.length > 0) {
    console.error(`\n❌ UNEXCEPTED VULNERABILITIES (${unexcepted.length}):`);
    console.error('The following vulnerabilities are not covered by a valid exception:\n');

    unexcepted.forEach((finding) => {
      console.error(`  Package: ${finding.name}`);
      console.error(`  Severity: ${finding.severity.toUpperCase()}`);
      console.error(`  Title: ${finding.title}`);
      if (finding.url) {
        console.error(`  URL: ${finding.url}`);
      }
      if (finding.expiredExceptionDate) {
        console.error(`  Note: Exception expired on ${finding.expiredExceptionDate}`);
      }
      console.error('');
    });

    console.error('To proceed, either:');
    console.error('1. Update the affected packages to resolve the vulnerabilities');
    console.error('2. Add a time-bound exception to .audit-exceptions.json (see docs/security/dependency-audit-policy.md)');
    console.error('');
  }

  // Fail the build if there are any unexcepted vulnerabilities or expired exceptions
  if (unexcepted.length > 0 || expired.length > 0) {
    process.exit(1);
  }

  console.log('✓ All vulnerabilities are covered by valid exceptions.');
  process.exit(0);
}

main();
