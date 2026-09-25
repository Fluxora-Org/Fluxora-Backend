# Security Audit Quick Reference

Fast reference for common security audit tasks.

## Daily Commands

```bash
# Check for vulnerabilities
pnpm run audit:security

# List current exceptions
pnpm run audit:list-exceptions

# Check for expired exceptions only
pnpm run audit:check-expired
```

## When You See a Vulnerability

### Option 1: Immediate Fix (Preferred)

```bash
# Update the vulnerable package
pnpm update <package-name>

# Or update all dependencies
pnpm update

# Run audit to confirm
pnpm run audit:security
```

### Option 2: Request Exception

If immediate fix is not possible, follow the exception process.

## Exception Request Template

Create/edit `.audit-exceptions.json`:

```json
{
  "exceptions": [
    {
      "id": "CVE-YYYY-XXXXX",
      "package": "package-name",
      "severity": "moderate",
      "reason": "Brief technical explanation of why exception is needed",
      "approvedBy": "your-email@example.com",
      "approvedDate": "YYYY-MM-DD",
      "expiryDate": "YYYY-MM-DD",
      "ticketUrl": "https://github.com/org/repo/issues/NNN",
      "notes": "Additional context or remediation plan"
    }
  ]
}
```

## Exception Expiry Limits

| Severity | Max Exception Duration |
|----------|----------------------|
| Critical | 14 days              |
| High     | 30 days              |
| Moderate | 60 days              |
| Low      | 90 days              |

## Approval Requirements

| Severity | Approver Required |
|----------|------------------|
| Critical | Security Team    |
| High     | Security Team    |
| Moderate | Tech Lead        |
| Low      | Tech Lead        |

## Common Scenarios

### Scenario: No Fix Available

```json
{
  "reason": "No patch available from maintainer. Upstream issue tracked at [URL]. Alternative package evaluation in progress."
}
```

### Scenario: Vulnerable Code Path Not Used

```json
{
  "reason": "The XSS vulnerability requires direct innerHTML assignment with user input, which our application never performs. All user content is sanitized via DOMPurify before rendering."
}
```

### Scenario: Transitive Dependency

```json
{
  "reason": "Transitive dependency of 'parent-package'. Vulnerability exists in 'child-package' v1.2.3. Parent package maintainer notified; awaiting update."
}
```

### Scenario: Breaking Change Required

```json
{
  "reason": "Fix requires upgrading to major version 5.x which has breaking API changes. Migration estimated at 3 sprints. Planned for Q2 2024."
}
```

## Finding CVE/Advisory IDs

```bash
# Run pnpm audit to see advisory details
pnpm audit --json | jq '.advisories'

# Look for:
# - "cves": ["CVE-2024-12345"]
# - "github_advisory_id": "GHSA-xxxx-yyyy-zzzz"
```

## Reviewing Exceptions in PRs

When reviewing a PR with exceptions:

1. **Verify technical justification** - Is the reason substantive?
2. **Check expiry date** - Within policy limits for severity?
3. **Confirm tracking issue** - Is there a linked GitHub issue?
4. **Assess remediation plan** - What's the path to fixing this?
5. **Review approval authority** - Is approver authorized for this severity?

## Exception Renewal

When an exception is expiring:

```bash
# Check current status
pnpm run audit:list-exceptions

# Update the exception
# 1. Edit .audit-exceptions.json
# 2. Update expiryDate (within max duration)
# 3. Update notes with current status
# 4. Get new approval in PR review
```

## CI Failures

### "Expired exceptions detected"

**Action**: Remove the exception and fix the vulnerability, or renew the exception.

```bash
# Check which exceptions expired
node scripts/audit-security.mjs --check-expired

# Fix the vulnerability
pnpm update <package-name>

# Or renew the exception (update expiryDate in .audit-exceptions.json)
```

### "Unexcepted vulnerabilities detected"

**Action**: Either fix immediately or request an exception.

```bash
# See vulnerability details
pnpm run audit:security

# Try updating first
pnpm update <package-name>

# If update doesn't work, request exception
```

### "Stale exceptions detected"

**Warning (not failure)**: An exception exists for a vulnerability that's no longer present.

**Action**: Remove the stale exception from `.audit-exceptions.json`.

## Emergency Overrides

❌ **There are no emergency overrides.**

The security job is a required gate. If you need to merge urgently:

1. Add a valid exception with short expiry (7 days minimum)
2. Get proper approval in PR review
3. Create tracking issue with high priority
4. Plan immediate remediation

## Scripts Location

- Audit script: `scripts/audit-security.mjs`
- Test script: `scripts/test-audit-with-vulnerability.mjs`
- Exception file: `.audit-exceptions.json`
- Example: `.audit-exceptions.example.json`

## Documentation

- **Full Policy**: [dependency-audit-policy.md](./dependency-audit-policy.md)
- **Validation Guide**: [audit-validation-guide.md](./audit-validation-guide.md)
- **General Security**: [../security.md](../security.md)

## Support

Questions about security audit?

- **Slack**: #security-team
- **Email**: security@example.com
- **Docs**: `docs/security/`

---

**Remember**: Security vulnerabilities are not negotiable. Every exception must have a remediation plan and expiry date.
