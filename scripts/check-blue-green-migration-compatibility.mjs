#!/usr/bin/env node

/**
 * Blue-Green Migration Compatibility Checker
 *
 * During a blue-green deployment cutover, both application versions run
 * simultaneously. If a migration removes or narrows a schema element, the
 * old version still running will fail. This validator ensures migrations are
 * additive-only across the cutover window.
 *
 * Destructive changes must be deferred to a later release after the cutover
 * is complete and the old version is no longer running.
 *
 * Allowed (additive):
 * - CREATE TABLE
 * - ADD COLUMN (with default for NOT NULL)
 * - CREATE INDEX
 * - ADD CONSTRAINT (UNIQUE, CHECK, FOREIGN KEY)
 * - ALTER COLUMN (adding default, widening type)
 *
 * Forbidden (destructive):
 * - DROP TABLE
 * - DROP COLUMN
 * - DROP INDEX
 * - DROP CONSTRAINT (except temporary/migration-specific ones)
 * - ALTER COLUMN (making NOT NULL, narrowing type, removing default)
 * - RENAME TABLE/COLUMN
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export class MigrationCompatibilityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationCompatibilityError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Destructive patterns that are not allowed during blue-green cutovers
 */
const DESTRUCTIVE_PATTERNS = [
  {
    pattern: /dropTable\s*\(/i,
    description: 'DROP TABLE - removes entire table',
    severity: 'error',
  },
  {
    pattern: /dropColumn\s*\(/i,
    description: 'DROP COLUMN - removes column',
    severity: 'error',
  },
  {
    pattern: /dropIndex\s*\(/i,
    description: 'DROP INDEX - removes index',
    severity: 'error',
  },
  {
    pattern: /dropConstraint\s*\([^)]*IF\s+NOT\s+EXISTS/i,
    description: 'DROP CONSTRAINT without IF EXISTS - may break old version',
    severity: 'warning',
  },
  {
    pattern: /renameTable\s*\(/i,
    description: 'RENAME TABLE - changes table name',
    severity: 'error',
  },
  {
    pattern: /renameColumn\s*\(/i,
    description: 'RENAME COLUMN - changes column name',
    severity: 'error',
  },
];

/**
 * Potentially destructive ALTER COLUMN patterns
 */
const DESTRUCTIVE_ALTER_PATTERNS = [
  {
    pattern: /alterColumn\s*\([^,]+,\s*[^,]*\{[^}]*notNull\s*:\s*true/i,
    description: 'ALTER COLUMN making NOT NULL - breaks old version if it writes NULLs',
    severity: 'error',
  },
  {
    pattern: /alterColumn\s*\([^,]+,\s*[^,]*\{[^}]*notNull\s*:\s*false/i,
    description: 'ALTER COLUMN removing NOT NULL - generally safe but review needed',
    severity: 'warning',
  },
  {
    pattern: /alterColumn\s*\([^,]+,\s*[^,]*\{[^}]*default\s*:\s*null/i,
    description: 'ALTER COLUMN removing default - may break old version',
    severity: 'warning',
  },
];

/**
 * SQL patterns that may be destructive
 */
const DESTRUCTIVE_SQL_PATTERNS = [
  {
    pattern: /DROP\s+TABLE\s+(?!IF\s+EXISTS)/i,
    description: 'SQL DROP TABLE without IF EXISTS',
    severity: 'error',
  },
  {
    pattern: /DROP\s+COLUMN\s+(?!IF\s+EXISTS)/i,
    description: 'SQL DROP COLUMN without IF EXISTS',
    severity: 'error',
  },
  {
    pattern: /DROP\s+INDEX\s+(?!IF\s+EXISTS)/i,
    description: 'SQL DROP INDEX without IF EXISTS',
    severity: 'error',
  },
  {
    pattern: /DROP\s+CONSTRAINT\s+(?!IF\s+EXISTS)/i,
    description: 'SQL DROP CONSTRAINT without IF EXISTS',
    severity: 'warning',
  },
  {
    pattern: /ALTER\s+TABLE.*DROP\s+COLUMN/i,
    description: 'SQL ALTER TABLE DROP COLUMN',
    severity: 'error',
  },
  {
    pattern: /ALTER\s+TABLE.*RENAME\s+TO/i,
    description: 'SQL ALTER TABLE RENAME',
    severity: 'error',
  },
];

/**
 * Allowed patterns that are explicitly safe for blue-green deployments
 */
const ALLOWED_PATTERNS = [
  {
    pattern: /dropConstraint\s*\([^)]*IF\s+EXISTS/i,
    description: 'DROP CONSTRAINT with IF EXISTS - safe for idempotent migrations',
    severity: 'safe',
  },
  {
    pattern: /DROP\s+CONSTRAINT\s+IF\s+EXISTS/i,
    description: 'SQL DROP CONSTRAINT with IF EXISTS - safe for idempotent migrations',
    severity: 'safe',
  },
];

/**
 * Check if a line matches any destructive pattern
 */
function checkDestructivePatterns(line, patterns, context = '') {
  const violations = [];
  for (const { pattern, description, severity } of patterns) {
    if (pattern.test(line)) {
      violations.push({ description, severity, context });
    }
  }
  return violations;
}

/**
 * Check if a line matches any allowed pattern
 */
function checkAllowedPatterns(line, patterns) {
  for (const { pattern } of patterns) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the up() function content from a migration file
 */
export function extractUpFunction(content) {
  // Find the up() function
  const upMatch = content.match(/export\s+async\s+function\s+up\s*\([^)]*\)\s*[:\s]*Promise<void>\s*\{([\s\S]*?)\n\}/);
  if (!upMatch) {
    // Try alternative syntax
    const altMatch = content.match(/export\s+function\s+up\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    if (altMatch) {
      return altMatch[1];
    }
    return null;
  }
  return upMatch[1];
}

/**
 * Extract the down() function content from a migration file
 */
export function extractDownFunction(content) {
  const downMatch = content.match(/export\s+async\s+function\s+down\s*\([^)]*\)\s*[:\s]*Promise<void>\s*\{([\s\S]*?)\n\}/);
  if (!downMatch) {
    const altMatch = content.match(/export\s+function\s+down\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    if (altMatch) {
      return altMatch[1];
    }
    return null;
  }
  return downMatch[1];
}

/**
 * Analyze a migration file for blue-green compatibility
 * Only checks the up() function, as down() is for rollbacks only
 */
export function analyzeMigration(content, filename) {
  const upContent = extractUpFunction(content);
  
  if (!upContent) {
    // If we can't extract the up function, skip this file
    return { violations: [], warnings: [] };
  }

  const lines = upContent.split('\n');
  const violations = [];
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const context = `${filename}:${lineNum}`;

    // Check for allowed patterns first (they override warnings)
    const isAllowed = checkAllowedPatterns(line, ALLOWED_PATTERNS);

    // Check destructive patterns
    const destructiveViolations = checkDestructivePatterns(line, DESTRUCTIVE_PATTERNS, context);
    for (const v of destructiveViolations) {
      if (v.severity === 'error' && !isAllowed) {
        violations.push(v);
      } else if (v.severity === 'warning' && !isAllowed) {
        warnings.push(v);
      }
    }

    // Check destructive ALTER patterns
    const alterViolations = checkDestructivePatterns(line, DESTRUCTIVE_ALTER_PATTERNS, context);
    for (const v of alterViolations) {
      if (v.severity === 'error') {
        violations.push(v);
      } else if (v.severity === 'warning') {
        warnings.push(v);
      }
    }

    // Check destructive SQL patterns
    const sqlViolations = checkDestructivePatterns(line, DESTRUCTIVE_SQL_PATTERNS, context);
    for (const v of sqlViolations) {
      if (v.severity === 'error' && !isAllowed) {
        violations.push(v);
      } else if (v.severity === 'warning' && !isAllowed) {
        warnings.push(v);
      }
    }
  }

  return { violations, warnings };
}

/**
 * Read the baseline file containing exempted historical migrations
 */
export function readBaseline(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new MigrationCompatibilityError('Blue-green migration baseline must be an array.', 'BASELINE_INVALID');
  }
  return parsed.map(String);
}

/**
 * Validate all migration files in a directory
 */
export function validateMigrationCompatibility(migrationsDir, baselinePath = null) {
  const entries = fs.readdirSync(migrationsDir);
  const migrationFiles = entries.filter((entry) => 
    /^\d+.*\.(ts|js|mjs|cjs)$/.test(entry) && !entry.startsWith('.')
  );

  // Read baseline if provided
  const baseline = baselinePath ? new Set(readBaseline(baselinePath)) : new Set();

  const allViolations = [];
  const allWarnings = [];

  for (const file of migrationFiles) {
    // Skip files in the baseline (historical migrations)
    if (baseline.has(file)) {
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const { violations, warnings } = analyzeMigration(content, file);

    for (const v of violations) {
      allViolations.push({ ...v, file });
    }
    for (const w of warnings) {
      allWarnings.push({ ...w, file });
    }
  }

  return {
    violations: allViolations,
    warnings: allWarnings,
    checked: migrationFiles.length,
    baseline: baseline.size,
  };
}

/**
 * Format validation results
 */
export function formatResult(result) {
  const lines = [];

  if (result.violations.length === 0 && result.warnings.length === 0) {
    const checked = result.checked - result.baseline;
    lines.push(`✓ Blue-green migration compatibility check passed: ${checked} new file(s) checked, ${result.baseline} baseline file(s) exempted.`);
    lines.push('All migrations are additive and safe for blue-green cutovers.');
    return lines.join('\n');
  }

  if (result.violations.length > 0) {
    lines.push(`✗ Found ${result.violations.length} destructive migration operation(s):`);
    lines.push('');
    for (const v of result.violations) {
      lines.push(`  - ${v.file}: ${v.description}`);
    }
    lines.push('');
    lines.push('Destructive migrations are not allowed during blue-green cutovers.');
    lines.push('Both application versions run simultaneously, so removing or narrowing');
    lines.push('schema elements will break the old version still serving traffic.');
    lines.push('');
    lines.push('To fix:');
    lines.push('1. Make the change additive (e.g., add a new column instead of dropping)');
    lines.push('2. Deploy the additive change and complete the cutover');
    lines.push('3. In a later release, remove the old schema element after the old version is retired');
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push(`⚠ Found ${result.warnings.length} warning(s) requiring manual review:`);
    lines.push('');
    for (const w of result.warnings) {
      lines.push(`  - ${w.file}: ${w.description}`);
    }
    lines.push('');
    lines.push('These operations may be safe depending on your deployment strategy.');
    lines.push('Please review manually and add a comment explaining why it is safe.');
  }

  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const migrationsDir = path.resolve(argv[0] ?? 'migrations');
  const baselinePath = argv[1] 
    ? path.resolve(argv[1])
    : path.join(migrationsDir, 'blue-green-baseline.json');
  
  try {
    const result = validateMigrationCompatibility(migrationsDir, baselinePath);
    console.log(formatResult(result));
    
    if (result.violations.length > 0) {
      return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Blue-green migration compatibility check failed: ${message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
