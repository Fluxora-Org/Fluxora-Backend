# Dependency Audit Policy

## Overview

All npm dependencies are automatically audited for known security vulnerabilities during CI builds. This policy defines the enforcement rules, remediation windows, and exception process.

## Enforcement Rules

### Audit Levels

The security audit enforces the following severity levels:

- **Critical**: Immediate action required
- **High**: Must be addressed within remediation window
- **Moderate**: Must be addressed within remediation window
- **Low**: Advisory only, does not fail builds

### Build Failure Conditions

A CI build will **fail** if any of the following conditions are met:

1. A vulnerability at `moderate` severity or above is detected
2. An exception exists but has **expired**
3. An exception references a vulnerability that no longer exists (stale exception)

### Bypass Prevention

- The audit job is a **required gate** in CI
- No shell fallback or advisory-only mode is permitted
- All exceptions must be reviewed and approved before merge

## Remediation Windows

Security vulnerabilities must be remediated within the following timeframes from initial detection:

| Severity | Remediation Window | Notes |
|----------|-------------------|-------|
| **Critical** | 7 days | Immediate priority; consider hotfix deployment |
| **High** | 14 days | High priority; plan into current sprint |
| **Moderate** | 30 days | Standard priority; plan into upcoming sprint |
| **Low** | 90 days (advisory) | Low priority; address during maintenance |

## Exception Process

### When to Request an Exception

Exceptions should only be requested when:

1. **No fix available**: The vulnerability has no published fix from the maintainer
2. **Non-exploitable**: The vulnerable code path is not used by our application
3. **Transitive dependency**: Vulnerability is in a sub-dependency and updating the direct dependency doesn't resolve it
4. **Breaking change**: The fix requires a major version upgrade with breaking changes requiring significant refactoring

### Exception File Format

Exceptions are recorded in `.audit-exceptions.json` at the repository root:

```json
{
  "exceptions": [
    {
      "id": "CVE-2024-12345",
      "package": "example-package",
      "severity": "moderate",
      "reason": "Vulnerable code path not used in our implementation",
      "approvedBy": "security-team@example.com",
      "approvedDate": "2024-01-15",
      "expiryDate": "2024-02-15",
      "ticketUrl": "https://github.com/org/repo/issues/123",
      "notes": "The XSS vulnerability requires user input to innerHTML, which we never do."
    }
  ]
}
```

### Exception Fields

- **id** (required): CVE identifier or advisory ID (e.g., `CVE-2024-12345` or `GHSA-xxxx-yyyy-zzzz`)
- **package** (required): Name of the affected package
- **severity** (required): One of `critical`, `high`, `moderate`, `low`
- **reason** (required): Justification for the exception (must be substantive)
- **approvedBy** (required): Email or identifier of approver (security team member)
- **approvedDate** (required): ISO 8601 date when exception was approved
- **expiryDate** (required): ISO 8601 date when exception expires (must follow remediation window)
- **ticketUrl** (optional): Link to tracking issue or remediation plan
- **notes** (optional): Additional context or technical details

### Maximum Exception Duration

Exception expiry dates are constrained by severity:

- **Critical**: Maximum 14 days
- **High**: Maximum 30 days
- **Moderate**: Maximum 60 days
- **Low**: Maximum 90 days

### Exception Workflow

1. **Detection**: CI audit identifies a vulnerability
2. **Assessment**: Security team evaluates exploitability and impact
3. **Decision**:
   - If remediable immediately → fix and deploy
   - If requires exception → proceed to step 4
4. **Documentation**: Create exception entry in `.audit-exceptions.json`
5. **Review**: Exception must be approved in PR review by:
   - Security team member (for high/critical)
   - Tech lead or senior engineer (for moderate/low)
6. **Tracking**: Create GitHub issue linked in `ticketUrl` to track remediation
7. **Merge**: PR with exception can be merged after approval
8. **Monitoring**: CI will fail when exception expires, forcing re-evaluation

### Exception Renewal

When an exception is approaching expiry:

1. Re-assess the vulnerability status
2. Check if a fix has become available
3. If still no fix available:
   - Update the `expiryDate` (within maximum duration constraints)
   - Update `notes` with current status
   - Requires new approval

## Audit Tooling

### Audit Script

The `scripts/audit-security.mjs` script performs the audit and exception validation:

```bash
# Run audit with exception handling
node scripts/audit-security.mjs

# Check for expired exceptions only
node scripts/audit-security.mjs --check-expired

# List all active exceptions
node scripts/audit-security.mjs --list-exceptions
```

### CI Integration

The security job in `.github/workflows/ci.yml` runs the audit script:

```yaml
- name: Run security audit
  run: node scripts/audit-security.mjs
```

### Pre-commit Hook (Optional)

Teams may optionally install a pre-commit hook to catch vulnerabilities early:

```bash
# .git/hooks/pre-commit
#!/bin/bash
node scripts/audit-security.mjs --check-expired
```

## Responsibilities

### Development Team

- Monitor for new vulnerabilities in dependencies
- Propose updates to address vulnerabilities
- Document exception requests with technical justification
- Track remediation work via GitHub issues

### Security Team

- Review and approve exception requests
- Audit exception renewal requests
- Monitor industry advisories for emerging threats
- Periodically review exception policy effectiveness

### Tech Lead / Engineering Manager

- Prioritize remediation work within sprint planning
- Ensure remediation windows are met
- Escalate blocked or expired exceptions
- Approve moderate/low exception requests

## Reporting

### Weekly Report

Every Monday, the security team receives an automated report containing:

- Active exceptions approaching expiry (within 7 days)
- New vulnerabilities detected in the previous week
- Overdue remediation items

### Monthly Metrics

The following metrics are tracked monthly:

- Total vulnerabilities detected by severity
- Mean time to remediation by severity
- Exception utilization rate (% of vulnerabilities requiring exception)
- Exception expiry compliance (% of exceptions renewed before expiry)

## Policy Review

This policy is reviewed quarterly by the security team and updated as needed based on:

- Industry best practices evolution
- Tool capability changes (pnpm audit features)
- Internal incident retrospectives
- Exception pattern analysis

**Last reviewed**: 2024-01-15  
**Next review due**: 2024-04-15  
**Policy version**: 1.0.0
