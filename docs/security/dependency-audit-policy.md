# Dependency Audit Policy

## Overview

All dependencies are continuously audited for known security vulnerabilities. Findings at or above the configured severity threshold **fail the build** unless an explicit, time-bound exception is recorded.

## Severity Thresholds

The audit enforces at **moderate** severity and above:
- **Critical**: Immediate remediation required
- **High**: Remediation required
- **Moderate**: Remediation required

Advisories below moderate (low/info) do not block the build but should be reviewed during dependency updates.

## Remediation Windows by Severity

| Severity | Maximum Remediation Window | Notes |
|----------|---------------------------|-------|
| **Critical** | 7 days | Must be addressed immediately; exceptions require engineering lead approval |
| **High** | 14 days | Urgent remediation; exceptions require team lead approval |
| **Moderate** | 30 days | Standard remediation window; exceptions require peer review |

These windows begin from the date the vulnerability is first detected in CI or local audit runs.

## Exception Process

### When to File an Exception

Exceptions are appropriate when:
1. **No patch is available** and a workaround or mitigation is in place
2. **The vulnerable code path is not reachable** in our application (must be verified)
3. **Breaking changes** in the fix require coordinated migration across services
4. **False positive** confirmed by manual analysis

Exceptions are **not** appropriate for:
- Convenience or to defer work
- Vulnerabilities with available patches
- Issues that can be resolved by updating dependencies

### Recording an Exception

Exceptions are stored in `.audit-exceptions.json` at the repository root:

```json
{
  "exceptions": [
    {
      "name": "package-name",
      "reason": "No patch available; vulnerable code path unreachable (see JIRA-1234)",
      "severity": "moderate",
      "expiry": "2026-11-15",
      "approvedBy": "alice@example.com",
      "createdAt": "2026-10-15"
    }
  ]
}
```

**Required fields:**
- `name`: Exact package name from `pnpm audit` output
- `reason`: Detailed justification referencing issue tracker or documentation
- `severity`: `critical`, `high`, or `moderate`
- `expiry`: ISO date (YYYY-MM-DD) when the exception expires; must align with remediation windows above
- `approvedBy`: Email of the approver (engineering lead for critical, team lead for high, peer for moderate)
- `createdAt`: ISO date when the exception was created

### Exception Expiry

When an exception expires:
1. The build **fails** immediately
2. The team must either:
   - **Remediate** the vulnerability by updating or replacing the dependency
   - **Renew** the exception with updated justification and a new expiry date (subject to approval)

Renewal requires demonstrating that:
- The original reason still applies (e.g., patch still unavailable)
- Mitigations remain effective
- The risk is actively monitored

## Validation in CI

The `security` job in `.github/workflows/ci.yml` runs:

```bash
pnpm run audit:check
```

This script:
1. Runs `pnpm audit --audit-level=moderate --json`
2. Parses the output for moderate/high/critical findings
3. Cross-references findings against `.audit-exceptions.json`
4. Checks exception expiry dates
5. **Fails with exit code 1** if:
   - Any finding lacks a valid exception
   - Any exception has expired
   - The exceptions file is malformed

## Local Development

Developers can run the audit check locally:

```bash
pnpm run audit:check
```

To review all current advisories without blocking:

```bash
pnpm audit --audit-level=moderate
```

To update the lockfile and resolve advisories:

```bash
pnpm update --recursive --latest
pnpm audit --audit-level=moderate
```

## Monitoring and Review

- **Weekly**: Automated scan reviews exceptions nearing expiry (alerts in Slack)
- **Monthly**: Security team reviews all active exceptions
- **Quarterly**: Full dependency audit and exception policy review

## Exception File Schema

The `.audit-exceptions.json` file must be valid JSON. A template is provided in `.audit-exceptions.example.json`.

To validate your exceptions file:

```bash
node scripts/audit-security.mjs --validate
```

## References

- [pnpm audit documentation](https://pnpm.io/cli/audit)
- [National Vulnerability Database (NVD)](https://nvd.nist.gov/)
- Internal JIRA board for security tracking: `SECURITY-*` issues
