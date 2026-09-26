# Dependency Audit Quick Reference

## Common Commands

```bash
# Run enforcing audit check (as used in CI)
pnpm run audit:check

# Validate exceptions file format
pnpm run audit:validate

# View all advisories (non-blocking)
pnpm audit

# View moderate+ advisories
pnpm audit --audit-level=moderate

# Update dependencies and re-audit
pnpm update --recursive --latest
pnpm run audit:check
```

## Remediation Workflows

### Resolving a Vulnerability

1. **Check for updates:**
   ```bash
   pnpm outdated
   pnpm update <package-name>
   ```

2. **If no update available, check transitive deps:**
   ```bash
   pnpm why <package-name>
   # Update the root dependency instead
   ```

3. **Verify resolution:**
   ```bash
   pnpm run audit:check
   ```

### Adding an Exception

1. **Verify no patch is available** or confirm mitigation is in place

2. **Edit `.audit-exceptions.json`:**
   ```json
   {
     "exceptions": [
       {
         "name": "package-name",
         "reason": "Detailed justification with JIRA-1234 reference",
         "severity": "moderate",
         "expiry": "2026-11-15",
         "approvedBy": "lead@example.com",
         "createdAt": "2026-10-15"
       }
     ]
   }
   ```

3. **Validate the exception:**
   ```bash
   pnpm run audit:validate
   ```

4. **Get approval** (per severity requirements in policy)

5. **Commit and push:**
   ```bash
   git add .audit-exceptions.json
   git commit -m "security: add exception for package-name (JIRA-1234)"
   ```

### Renewing an Expired Exception

1. **Review the original justification** - does it still apply?

2. **Update the expiry date** in `.audit-exceptions.json`:
   ```json
   {
     "expiry": "2026-12-15",
     "createdAt": "2026-11-15"
   }
   ```

3. **Update the reason** with renewal justification:
   ```json
   {
     "reason": "Renewed: no patch available upstream; monitoring github.com/org/pkg/issues/123"
   }
   ```

4. **Get renewed approval** and commit

## Exception Templates

### No Patch Available

```json
{
  "name": "vulnerable-package",
  "reason": "No patch available from upstream. Vulnerable code path not exercised (verified in code review JIRA-1234). Monitoring github.com/org/pkg/issues/567.",
  "severity": "moderate",
  "expiry": "2026-11-30",
  "approvedBy": "security-lead@example.com",
  "createdAt": "2026-10-15"
}
```

### Breaking Changes Required

```json
{
  "name": "legacy-dep",
  "reason": "Patch requires v2.x migration with breaking changes. Migration planned for Q4 2026 (PROJ-789). Workaround: input sanitization in src/middleware/sanitize.ts",
  "severity": "high",
  "expiry": "2026-12-01",
  "approvedBy": "tech-lead@example.com",
  "createdAt": "2026-10-20"
}
```

### Unreachable Code Path

```json
{
  "name": "indirect-dep",
  "reason": "Vulnerability in unused feature flag path. Verified via code coverage: feature disabled in production config. Tracking upstream fix in SECURITY-456.",
  "severity": "moderate",
  "expiry": "2026-11-20",
  "approvedBy": "peer@example.com",
  "createdAt": "2026-10-18"
}
```

## Severity Guidelines

| Severity | Max Window | Required Approval | Example |
|----------|-----------|-------------------|---------|
| Critical | 7 days | Engineering Lead | RCE, Auth bypass |
| High | 14 days | Team Lead | SQL injection, XSS |
| Moderate | 30 days | Peer Review | DoS, Info disclosure |

## CI Failure Resolution

When CI fails on the security job:

1. **Check the error output** - which vulnerabilities are unexcepted?

2. **Run locally:**
   ```bash
   pnpm install
   pnpm run audit:check
   ```

3. **Choose a path:**
   - **Remediate:** Update the package
   - **Exception:** Add to `.audit-exceptions.json` with approval

4. **Re-run CI** by pushing the fix

## Monitoring

- **Expiry warnings:** Exceptions within 7 days of expiry show warnings in output
- **Weekly scans:** Automated review of active exceptions
- **Slack alerts:** Notifications for critical/high findings

## Files Reference

| File | Purpose |
|------|---------|
| `.audit-exceptions.json` | Active exceptions |
| `.audit-exceptions.example.json` | Template and examples |
| `scripts/audit-security.mjs` | Enforcement script |
| `docs/security/dependency-audit-policy.md` | Full policy |

## Getting Help

- Policy questions: See `docs/security/dependency-audit-policy.md`
- Technical issues: Open issue with `security` label
- Approval needed: Ping in `#security` Slack channel
