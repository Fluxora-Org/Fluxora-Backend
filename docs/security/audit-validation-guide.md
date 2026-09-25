# Security Audit Validation Guide

This guide walks through validating that the security audit enforcement and exception process work correctly.

## Prerequisites

- Local development environment with Node.js and pnpm installed
- Access to commit to a test branch
- Familiarity with npm advisory database

## Validation Steps

### 1. Baseline Check

First, verify the audit passes on the current main branch:

```bash
# Install dependencies
pnpm install

# Run audit
node scripts/audit-security.mjs
```

Expected output:
```
🔒 Security Audit with Exception Management

🔍 Running security audit (level: moderate)...

✅ No vulnerabilities detected at or above moderate severity.

✅ Security audit passed.
```

### 2. Introduce a Known Vulnerability

Find a package with a known moderate or higher severity vulnerability from the [npm advisory database](https://github.com/advisories).

#### Option A: Use a Historical Vulnerability

These packages had known vulnerabilities (verify current status before using):

```bash
# Example: axios with historical SSRF vulnerability
pnpm add axios@0.21.1

# Example: minimist with prototype pollution
pnpm add minimist@1.2.5

# Example: express with historical issues
pnpm add express@4.16.0
```

#### Option B: Check Current Advisories

```bash
# Search for packages with current advisories
pnpm audit --json | jq '.advisories'
```

### 3. Verify Build Failure

Run the audit script and confirm it fails:

```bash
node scripts/audit-security.mjs
```

Expected output:
```
🔒 Security Audit with Exception Management

🔍 Running security audit (level: moderate)...

❌ UNEXCEPTED VULNERABILITIES DETECTED

  • CVE-2021-3749 (axios)
    Severity: moderate
    Title: Server-Side Request Forgery
    More info: https://github.com/advisories/GHSA-xxxx-yyyy-zzzz
    Remediation window: 30 days

Build failed: 1 vulnerability(ies) without valid exceptions.
Action required: Remediate or request exception.

See docs/security/dependency-audit-policy.md for exception process.
```

### 4. Create an Exception

Add an exception to `.audit-exceptions.json`:

```json
{
  "exceptions": [
    {
      "id": "CVE-2021-3749",
      "package": "axios",
      "severity": "moderate",
      "reason": "Validation test: SSRF vulnerability does not affect our usage pattern as we only make requests to trusted internal services with hardcoded URLs.",
      "approvedBy": "security-test@example.com",
      "approvedDate": "2024-01-15",
      "expiryDate": "2024-02-15",
      "ticketUrl": "https://github.com/your-org/your-repo/issues/999",
      "notes": "Test exception for audit validation. Remove after validation complete."
    }
  ]
}
```

**Important**: Adjust dates to current date and 30 days in the future (moderate severity max).

### 5. Verify Exception Handling

Run the audit again with the exception in place:

```bash
node scripts/audit-security.mjs
```

Expected output:
```
🔒 Security Audit with Exception Management

🔍 Running security audit (level: moderate)...

✓ 1 vulnerability(ies) covered by active exceptions:

  • CVE-2021-3749 (axios) - moderate
    Exception expires: 2024-02-15 (in 30 days)
    Reason: Validation test: SSRF vulnerability does not affect our usage...
    Tracking: https://github.com/your-org/your-repo/issues/999

✅ Security audit passed (all vulnerabilities excepted).
```

### 6. Test Exception Expiry

Modify the exception's `expiryDate` to yesterday's date:

```json
{
  "exceptions": [
    {
      "id": "CVE-2021-3749",
      "package": "axios",
      "severity": "moderate",
      "reason": "...",
      "approvedBy": "security-test@example.com",
      "approvedDate": "2024-01-15",
      "expiryDate": "2024-01-14",  // <-- Set to past date
      "ticketUrl": "...",
      "notes": "..."
    }
  ]
}
```

Run the audit:

```bash
node scripts/audit-security.mjs
```

Expected output:
```
🔒 Security Audit with Exception Management

❌ EXPIRED EXCEPTIONS DETECTED

  • CVE-2021-3749 (axios)
    Severity: moderate
    Expired: 2024-01-14 (1 days ago)
    Approved by: security-test@example.com
    Tracking: https://github.com/your-org/your-repo/issues/999

Build failed: 1 exception(s) have expired.
Action required: Remove the exception and remediate, or request renewal.
```

### 7. Test Exception Validation

Test various validation rules by introducing invalid exceptions:

#### Missing Required Field

```json
{
  "exceptions": [
    {
      "id": "CVE-2021-3749",
      "package": "axios",
      "severity": "moderate"
      // Missing: reason, approvedBy, approvedDate, expiryDate
    }
  ]
}
```

Expected: Validation error listing missing fields.

#### Invalid Severity

```json
{
  "exceptions": [
    {
      "id": "CVE-2021-3749",
      "package": "axios",
      "severity": "super-critical",  // Invalid value
      "reason": "Test",
      "approvedBy": "test@example.com",
      "approvedDate": "2024-01-15",
      "expiryDate": "2024-02-15"
    }
  ]
}
```

Expected: Validation error about invalid severity.

#### Exceeds Maximum Duration

```json
{
  "exceptions": [
    {
      "id": "CVE-2021-3749",
      "package": "axios",
      "severity": "moderate",
      "reason": "Test",
      "approvedBy": "test@example.com",
      "approvedDate": "2024-01-15",
      "expiryDate": "2024-05-15"  // 120 days (moderate max is 60)
    }
  ]
}
```

Expected: Validation error about duration exceeding maximum.

### 8. Test Stale Exception Detection

Remove the vulnerable package while keeping the exception:

```bash
pnpm remove axios
node scripts/audit-security.mjs
```

Expected output should include:
```
⚠️  STALE EXCEPTIONS DETECTED

The following exceptions reference vulnerabilities that are no longer detected:

  • CVE-2021-3749 (axios) - moderate
    Consider removing this exception.
```

### 9. Test CI Integration

Create a test branch and push:

```bash
git checkout -b test/audit-enforcement
git add .audit-exceptions.json package.json pnpm-lock.yaml
git commit -m "test: validate audit enforcement with known vulnerability"
git push origin test/audit-enforcement
```

Open a PR and verify:
1. The `Security Audit` job runs
2. With a valid exception, the job passes
3. With an expired exception, the job fails
4. Without an exception, the job fails

### 10. Test Expiry Warning

Set an exception to expire in 5 days:

```json
{
  "expiryDate": "2024-01-20"  // 5 days from now
}
```

Run the audit:

```bash
node scripts/audit-security.mjs
```

Expected: Warning about exception expiring soon.

### 11. List Exceptions

Test the list command:

```bash
node scripts/audit-security.mjs --list-exceptions
```

Expected output:
```
📋 ACTIVE EXCEPTIONS (1)

Active:

  • CVE-2021-3749 (axios)
    Severity: moderate
    Expires: 2024-02-15 (in 30 days)
    Reason: Validation test: SSRF vulnerability...
    Tracking: https://github.com/your-org/your-repo/issues/999
```

### 12. Cleanup

Remove test artifacts:

```bash
# Remove vulnerable package
pnpm remove axios  # (or whatever package you installed)

# Restore exception file
git checkout .audit-exceptions.json

# Verify clean state
node scripts/audit-security.mjs

# Delete test branch
git checkout main
git branch -D test/audit-enforcement
git push origin --delete test/audit-enforcement
```

## Validation Checklist

Use this checklist to confirm all aspects are working:

- [ ] Baseline audit passes with no exceptions
- [ ] Audit fails when vulnerability is introduced
- [ ] Audit passes when valid exception is added
- [ ] Audit fails when exception expires
- [ ] Exception validation catches missing required fields
- [ ] Exception validation catches invalid severity values
- [ ] Exception validation catches duration exceeding maximum
- [ ] Stale exception warning appears when vulnerability is removed
- [ ] Expiry warning appears for exceptions expiring within 7 days
- [ ] List command displays all exceptions correctly
- [ ] CI job fails on unexcepted vulnerabilities
- [ ] CI job passes with valid exceptions
- [ ] CI job fails on expired exceptions

## Troubleshooting

### Audit script not finding vulnerabilities

If `pnpm audit` doesn't detect the vulnerability:
- The package version may have been patched
- Try a different package or version
- Check the npm advisory database for current vulnerabilities

### JSON parse errors

If you see JSON parsing errors:
- Validate `.audit-exceptions.json` syntax (use a JSON validator)
- Ensure dates are in ISO 8601 format: `YYYY-MM-DD`
- Check for trailing commas (not valid in JSON)

### CI not failing as expected

- Verify the workflow file uses `node scripts/audit-security.mjs`
- Check that `.audit-exceptions.json` is committed
- Review CI logs for script execution details

## Next Steps

After successful validation:

1. Document the validation results
2. Train team members on the exception process
3. Set up monitoring for expiring exceptions
4. Schedule quarterly policy reviews
5. Integrate exception metrics into security dashboards

## References

- [Dependency Audit Policy](./dependency-audit-policy.md)
- [npm Advisory Database](https://github.com/advisories)
- [NIST National Vulnerability Database](https://nvd.nist.gov/)
- [Common Vulnerability Scoring System (CVSS)](https://www.first.org/cvss/)
