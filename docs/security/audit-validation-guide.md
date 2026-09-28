# Audit Enforcement Validation Guide

This guide walks through validating that the audit enforcement system works as intended.

## Quick Validation

To verify the audit system is functioning without introducing real vulnerabilities:

```bash
# Validate the exceptions file format
pnpm run audit:validate

# Run the full audit check
pnpm run audit:check
```

## Full Validation Workflow

### Prerequisites

- Node.js 20+ and pnpm installed
- Access to the repository with write permissions
- Clean working directory (commit or stash changes)

### Step 1: Test Current State

Run the audit check to establish baseline:

```bash
pnpm run audit:check
```

**Expected outcome:**
- If no vulnerabilities exist: Script exits with code 0 and reports "No vulnerabilities found"
- If vulnerabilities exist but are excepted: Script exits with code 0 and reports "All vulnerabilities are covered by valid exceptions"
- If unexcepted vulnerabilities exist: Script exits with code 1 and lists the findings

### Step 2: Simulate a Vulnerability

Use the provided test script to simulate the full enforcement workflow:

```bash
node scripts/test-audit-with-vulnerability.mjs
```

This script:
1. Backs up your current `.audit-exceptions.json`
2. Tests audit enforcement with no exceptions
3. Tests with valid exceptions
4. Tests with expired exceptions
5. Restores your original exceptions file

**Expected outcome:**
- The script should report that audit:check correctly fails without exceptions
- The script should show exception handling works as expected

### Step 3: Introduce a Real Vulnerability (Optional)

For comprehensive validation, temporarily install a package with a known vulnerability:

```bash
# Example: install an old version of a package with known issues
pnpm add -D lodash@4.17.19

# Run audit
pnpm run audit:check
```

**Expected outcome:**
- The script should detect the vulnerability
- Build should fail with exit code 1
- Error message should list the specific vulnerability

### Step 4: Test Exception Process

Add an exception for the vulnerability:

```json
{
  "exceptions": [
    {
      "name": "lodash",
      "reason": "Testing exception process - to be removed immediately",
      "severity": "moderate",
      "expiry": "2026-10-30",
      "approvedBy": "your-email@example.com",
      "createdAt": "2026-10-01"
    }
  ]
}
```

Run audit again:

```bash
pnpm run audit:check
```

**Expected outcome:**
- Build should pass with the exception in place
- Script should report "All vulnerabilities are covered by valid exceptions"

### Step 5: Test Expired Exception

Modify the exception's expiry date to a past date:

```json
{
  "expiry": "2020-01-01"
}
```

Run audit:

```bash
pnpm run audit:check
```

**Expected outcome:**
- Build should fail with exit code 1
- Error should explicitly mention the expired exception

### Step 6: Cleanup

Remove the test vulnerability and exceptions:

```bash
pnpm remove lodash
# Restore .audit-exceptions.json to original state
```

## CI Validation

The audit enforcement runs automatically in CI as part of the `security` job:

1. Push a branch with an unexcepted vulnerability
2. Observe the CI security job fail
3. Add a valid exception and push again
4. Observe the CI security job pass

## Validation Checklist

- [ ] `pnpm run audit:validate` validates exceptions file format
- [ ] `pnpm run audit:check` passes when no vulnerabilities exist
- [ ] Unexcepted vulnerabilities fail the build (exit code 1)
- [ ] Valid exceptions allow the build to proceed (exit code 0)
- [ ] Expired exceptions fail the build (exit code 1)
- [ ] Exceptions nearing expiry show warnings
- [ ] Malformed exceptions file is rejected with clear error
- [ ] CI security job integrates the audit check
- [ ] Error messages are clear and actionable

## Troubleshooting

### "Failed to load exceptions"

**Cause:** Malformed JSON in `.audit-exceptions.json`

**Solution:** Validate JSON syntax or run `pnpm run audit:validate` for detailed error

### "Exception missing or invalid field"

**Cause:** Required field is missing or has wrong type

**Solution:** Ensure all fields (name, reason, severity, expiry, approvedBy, createdAt) are present and correctly formatted

### Audit passes but vulnerabilities visible

**Cause:** Vulnerabilities below moderate severity, or covered by exceptions

**Solution:** Review `pnpm audit` output for full details; exceptions file for coverage

### Script fails with "pnpm audit not found"

**Cause:** pnpm not installed or not in PATH

**Solution:** Install pnpm: `npm install -g pnpm` or via corepack

## Continuous Validation

The audit enforcement is validated continuously through:

1. **Pre-merge CI**: Every PR runs the audit check
2. **Nightly scans**: Scheduled workflow checks for new advisories
3. **Dependabot**: Automated PRs for security updates
4. **Weekly reviews**: Security team reviews active exceptions
