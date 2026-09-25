#!/usr/bin/env node
/**
 * Security Audit Script with Exception Management
 * 
 * This script runs pnpm audit and validates exceptions against the policy.
 * Exceptions are stored in .audit-exceptions.json at the repository root.
 * 
 * Usage:
 *   node scripts/audit-security.mjs                 # Run full audit
 *   node scripts/audit-security.mjs --check-expired  # Check only for expired exceptions
 *   node scripts/audit-security.mjs --list-exceptions # List all exceptions
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const EXCEPTIONS_FILE = '.audit-exceptions.json';
const AUDIT_LEVEL = 'moderate';

// Maximum exception durations by severity (in days)
const MAX_EXCEPTION_DURATION = {
  critical: 14,
  high: 30,
  moderate: 60,
  low: 90,
};

// Remediation windows by severity (in days)
const REMEDIATION_WINDOWS = {
  critical: 7,
  high: 14,
  moderate: 30,
  low: 90,
};

class AuditException {
  constructor(data) {
    this.id = data.id;
    this.package = data.package;
    this.severity = data.severity;
    this.reason = data.reason;
    this.approvedBy = data.approvedBy;
    this.approvedDate = new Date(data.approvedDate);
    this.expiryDate = new Date(data.expiryDate);
    this.ticketUrl = data.ticketUrl || null;
    this.notes = data.notes || null;
  }

  isExpired() {
    return new Date() > this.expiryDate;
  }

  daysUntilExpiry() {
    const now = new Date();
    const diff = this.expiryDate - now;
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  validate() {
    const errors = [];

    if (!this.id) errors.push('Missing required field: id');
    if (!this.package) errors.push('Missing required field: package');
    if (!this.severity) errors.push('Missing required field: severity');
    if (!this.reason) errors.push('Missing required field: reason');
    if (!this.approvedBy) errors.push('Missing required field: approvedBy');
    if (!this.approvedDate || isNaN(this.approvedDate.getTime())) {
      errors.push('Invalid or missing approvedDate');
    }
    if (!this.expiryDate || isNaN(this.expiryDate.getTime())) {
      errors.push('Invalid or missing expiryDate');
    }

    const validSeverities = ['critical', 'high', 'moderate', 'low'];
    if (this.severity && !validSeverities.includes(this.severity)) {
      errors.push(`Invalid severity: ${this.severity}. Must be one of: ${validSeverities.join(', ')}`);
    }

    // Check maximum exception duration
    if (this.severity && this.approvedDate && this.expiryDate) {
      const durationDays = Math.ceil((this.expiryDate - this.approvedDate) / (1000 * 60 * 60 * 24));
      const maxDuration = MAX_EXCEPTION_DURATION[this.severity];
      if (durationDays > maxDuration) {
        errors.push(
          `Exception duration (${durationDays} days) exceeds maximum for ${this.severity} severity (${maxDuration} days)`
        );
      }
    }

    return errors;
  }
}

function loadExceptions() {
  if (!existsSync(EXCEPTIONS_FILE)) {
    return [];
  }

  try {
    const content = readFileSync(EXCEPTIONS_FILE, 'utf-8');
    const data = JSON.parse(content);

    if (!data.exceptions || !Array.isArray(data.exceptions)) {
      console.error('❌ Invalid exception file format: missing or invalid "exceptions" array');
      process.exit(1);
    }

    return data.exceptions.map(e => new AuditException(e));
  } catch (error) {
    console.error(`❌ Failed to load exception file: ${error.message}`);
    process.exit(1);
  }
}

function validateExceptions(exceptions) {
  const errors = [];

  exceptions.forEach((exception, index) => {
    const validationErrors = exception.validate();
    if (validationErrors.length > 0) {
      errors.push({
        index,
        id: exception.id || 'unknown',
        errors: validationErrors,
      });
    }
  });

  return errors;
}

function checkExpiredExceptions(exceptions) {
  const expired = exceptions.filter(e => e.isExpired());

  if (expired.length > 0) {
    console.error('\n❌ EXPIRED EXCEPTIONS DETECTED\n');
    expired.forEach(e => {
      const daysExpired = Math.abs(e.daysUntilExpiry());
      console.error(`  • ${e.id} (${e.package})`);
      console.error(`    Severity: ${e.severity}`);
      console.error(`    Expired: ${e.expiryDate.toISOString().split('T')[0]} (${daysExpired} days ago)`);
      console.error(`    Approved by: ${e.approvedBy}`);
      if (e.ticketUrl) {
        console.error(`    Tracking: ${e.ticketUrl}`);
      }
      console.error('');
    });

    console.error(`Build failed: ${expired.length} exception(s) have expired.`);
    console.error('Action required: Remove the exception and remediate, or request renewal.\n');
    return false;
  }

  return true;
}

function checkExpiringExceptions(exceptions) {
  const expiringSoon = exceptions.filter(e => !e.isExpired() && e.daysUntilExpiry() <= 7);

  if (expiringSoon.length > 0) {
    console.warn('\n⚠️  EXCEPTIONS EXPIRING SOON\n');
    expiringSoon.forEach(e => {
      const days = e.daysUntilExpiry();
      console.warn(`  • ${e.id} (${e.package})`);
      console.warn(`    Severity: ${e.severity}`);
      console.warn(`    Expires: ${e.expiryDate.toISOString().split('T')[0]} (in ${days} days)`);
      if (e.ticketUrl) {
        console.warn(`    Tracking: ${e.ticketUrl}`);
      }
      console.warn('');
    });
  }
}

function runAudit() {
  console.log(`🔍 Running security audit (level: ${AUDIT_LEVEL})...\n`);

  try {
    const output = execSync(`pnpm audit --audit-level=${AUDIT_LEVEL} --json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // If we get here, audit passed
    console.log('✅ No vulnerabilities detected at or above moderate severity.\n');
    return { vulnerabilities: [], passed: true };
  } catch (error) {
    // pnpm audit exits with non-zero when vulnerabilities are found
    const output = error.stdout || '';

    try {
      const auditData = JSON.parse(output);
      return { vulnerabilities: extractVulnerabilities(auditData), passed: false };
    } catch (parseError) {
      console.error('❌ Failed to parse audit output:', parseError.message);
      console.error('Raw output:', output);
      process.exit(1);
    }
  }
}

function extractVulnerabilities(auditData) {
  const vulnerabilities = [];

  if (!auditData.advisories) {
    return vulnerabilities;
  }

  Object.values(auditData.advisories).forEach(advisory => {
    vulnerabilities.push({
      id: advisory.cves?.[0] || advisory.github_advisory_id || advisory.id,
      package: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
    });
  });

  return vulnerabilities;
}

function checkVulnerabilitiesAgainstExceptions(vulnerabilities, exceptions) {
  const unexcepted = [];
  const excepted = [];

  vulnerabilities.forEach(vuln => {
    const exception = exceptions.find(
      e => (e.id === vuln.id || e.package === vuln.package) && !e.isExpired()
    );

    if (exception) {
      excepted.push({ vulnerability: vuln, exception });
    } else {
      unexcepted.push(vuln);
    }
  });

  return { unexcepted, excepted };
}

function checkStaleExceptions(exceptions, vulnerabilities) {
  const activeVulnIds = new Set(vulnerabilities.map(v => v.id));
  const activeVulnPackages = new Set(vulnerabilities.map(v => v.package));

  const stale = exceptions.filter(e => {
    if (e.isExpired()) return false; // Already handled by expiry check
    return !activeVulnIds.has(e.id) && !activeVulnPackages.has(e.package);
  });

  if (stale.length > 0) {
    console.warn('\n⚠️  STALE EXCEPTIONS DETECTED\n');
    console.warn('The following exceptions reference vulnerabilities that are no longer detected:\n');
    stale.forEach(e => {
      console.warn(`  • ${e.id} (${e.package}) - ${e.severity}`);
      console.warn(`    Consider removing this exception.\n`);
    });
  }
}

function listExceptions(exceptions) {
  if (exceptions.length === 0) {
    console.log('No active exceptions found.\n');
    return;
  }

  console.log(`\n📋 ACTIVE EXCEPTIONS (${exceptions.length})\n`);

  const active = exceptions.filter(e => !e.isExpired());
  const expired = exceptions.filter(e => e.isExpired());

  if (active.length > 0) {
    console.log('Active:\n');
    active.forEach(e => {
      const days = e.daysUntilExpiry();
      console.log(`  • ${e.id} (${e.package})`);
      console.log(`    Severity: ${e.severity}`);
      console.log(`    Expires: ${e.expiryDate.toISOString().split('T')[0]} (in ${days} days)`);
      console.log(`    Reason: ${e.reason}`);
      if (e.ticketUrl) {
        console.log(`    Tracking: ${e.ticketUrl}`);
      }
      console.log('');
    });
  }

  if (expired.length > 0) {
    console.log('Expired:\n');
    expired.forEach(e => {
      const days = Math.abs(e.daysUntilExpiry());
      console.log(`  • ${e.id} (${e.package})`);
      console.log(`    Severity: ${e.severity}`);
      console.log(`    Expired: ${e.expiryDate.toISOString().split('T')[0]} (${days} days ago)`);
      console.log('');
    });
  }
}

function main() {
  const args = process.argv.slice(2);
  const checkExpiredOnly = args.includes('--check-expired');
  const listOnly = args.includes('--list-exceptions');

  console.log('🔒 Security Audit with Exception Management\n');

  // Load and validate exceptions
  const exceptions = loadExceptions();

  const validationErrors = validateExceptions(exceptions);
  if (validationErrors.length > 0) {
    console.error('❌ EXCEPTION FILE VALIDATION FAILED\n');
    validationErrors.forEach(({ index, id, errors }) => {
      console.error(`Exception #${index + 1} (${id}):`);
      errors.forEach(err => console.error(`  • ${err}`));
      console.error('');
    });
    process.exit(1);
  }

  if (listOnly) {
    listExceptions(exceptions);
    return;
  }

  // Check for expired exceptions (always enforced)
  const expiredOk = checkExpiredExceptions(exceptions);
  if (!expiredOk) {
    process.exit(1);
  }

  if (checkExpiredOnly) {
    console.log('✅ No expired exceptions.\n');
    return;
  }

  // Run audit
  const { vulnerabilities, passed } = runAudit();

  if (passed) {
    // No vulnerabilities, but still check for stale exceptions
    if (exceptions.length > 0) {
      checkStaleExceptions(exceptions, []);
    }
    checkExpiringExceptions(exceptions);
    console.log('✅ Security audit passed.\n');
    return;
  }

  // Vulnerabilities found - check against exceptions
  const { unexcepted, excepted } = checkVulnerabilitiesAgainstExceptions(vulnerabilities, exceptions);

  if (excepted.length > 0) {
    console.log(`\n✓ ${excepted.length} vulnerability(ies) covered by active exceptions:\n`);
    excepted.forEach(({ vulnerability, exception }) => {
      const days = exception.daysUntilExpiry();
      console.log(`  • ${vulnerability.id} (${vulnerability.package}) - ${vulnerability.severity}`);
      console.log(`    Exception expires: ${exception.expiryDate.toISOString().split('T')[0]} (in ${days} days)`);
      console.log(`    Reason: ${exception.reason}`);
      if (exception.ticketUrl) {
        console.log(`    Tracking: ${exception.ticketUrl}`);
      }
      console.log('');
    });
  }

  if (unexcepted.length > 0) {
    console.error('\n❌ UNEXCEPTED VULNERABILITIES DETECTED\n');
    unexcepted.forEach(vuln => {
      console.error(`  • ${vuln.id} (${vuln.package})`);
      console.error(`    Severity: ${vuln.severity}`);
      console.error(`    Title: ${vuln.title}`);
      console.error(`    More info: ${vuln.url}`);
      console.error(`    Remediation window: ${REMEDIATION_WINDOWS[vuln.severity]} days`);
      console.error('');
    });

    console.error(`Build failed: ${unexcepted.length} vulnerability(ies) without valid exceptions.`);
    console.error('Action required: Remediate or request exception.\n');
    console.error('See docs/security/dependency-audit-policy.md for exception process.\n');
    process.exit(1);
  }

  // Check for stale exceptions
  checkStaleExceptions(exceptions, vulnerabilities);

  // Warn about expiring exceptions
  checkExpiringExceptions(exceptions);

  console.log('✅ Security audit passed (all vulnerabilities excepted).\n');
}

main();
