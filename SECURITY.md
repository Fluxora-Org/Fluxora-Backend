# Security Policy

## Security Considerations

This document outlines the security measures implemented in the contract event indexer and recommendations for production deployment.

## Implemented Security Measures

### 1. SQL Injection Prevention

**Status**: ✅ Implemented

All database queries use **parameterized statements** to prevent SQL injection attacks:

```typescript
// ✅ SAFE - Parameterized query
await client.query(
  'SELECT * FROM contract_events WHERE contract_id = $1 AND ledger = $2',
  [contractId, ledger]
);

// ❌ NEVER DO THIS - String concatenation
await client.query(
  `SELECT * FROM contract_events WHERE contract_id = '${contractId}'`
);
```

**Test Coverage**: SQL injection attempts are tested in `tests/indexer/service.replay.test.ts`

### 2. Input Validation

**Status**: ✅ Implemented

All replay request parameters are validated before processing:

- `contract_id`: Must be non-empty string
- `ledger`: Must be non-negative integer
- `from_block`: Must be non-negative integer (if provided)
- `to_block`: Must be non-negative integer (if provided)
- `from_block` must be ≤ `to_block`

Invalid inputs are rejected with descriptive error messages.

### 3. Transaction Safety

**Status**: ✅ Implemented

All replay operations use database transactions:
- **Success**: Changes committed atomically
- **Failure**: Automatic rollback prevents partial updates
- **Connection errors**: Proper cleanup and resource release

### 4. Concurrent Operation Prevention

**Status**: ✅ Implemented

Only one replay operation can run at a time to prevent:
- Database connection pool exhaustion
- Memory pressure from multiple large operations
- Conflicting progress state

**Limitation**: Current implementation uses in-memory state. For multi-instance deployments, use Redis or database-backed locking.

### 5. Resource Management

**Status**: ✅ Implemented

- Connection pooling with configurable limits
- Automatic connection release in finally blocks
- Graceful shutdown handling
- Batch size limits to prevent memory exhaustion

## Required Security Measures for Production

### 1. Authentication & Authorization

**Status**: ⚠️ NOT IMPLEMENTED

The `/internal/indexer/*` endpoints are **not authenticated** by default.

**Required Actions**:

```typescript
// Example: Add authentication middleware
import { authenticate, authorize } from './middleware/auth';

// Require authentication for all internal endpoints
app.use('/internal', authenticate);

// Require specific role for replay operations
app.post('/internal/indexer/events/replay', 
  authorize(['admin', 'indexer-operator']),
  replayHandler
);
```

**Recommended Solutions**:
- JWT tokens with role-based access control
- API keys with rate limiting
- OAuth 2.0 for service-to-service authentication
- mTLS for internal service communication

### 2. Rate Limiting

**Status**: ⚠️ NOT IMPLEMENTED

**Required Actions**:

```typescript
import rateLimit from 'express-rate-limit';

const replayLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 replay requests per window
  message: 'Too many replay requests, please try again later'
});

app.post('/internal/indexer/events/replay', replayLimiter, replayHandler);
```

### 3. IP Whitelisting

**Status**: ⚠️ NOT IMPLEMENTED

**Required Actions**:

```typescript
const allowedIPs = process.env.ALLOWED_IPS?.split(',') || [];

function ipWhitelist(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!allowedIPs.includes(clientIP)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  next();
}

app.use('/internal', ipWhitelist);
```

### 4. HTTPS/TLS

**Status**: ⚠️ NOT IMPLEMENTED

**Required Actions**:
- Deploy behind a reverse proxy (nginx, HAProxy)
- Use Let's Encrypt for TLS certificates
- Enforce HTTPS redirects
- Enable HSTS headers

### 5. Secrets Management

**Status**: ⚠️ PARTIAL

**Current**: Environment variables in `.env` file

**Production Recommendations**:
- Use AWS Secrets Manager, HashiCorp Vault, or similar
- Rotate database credentials regularly
- Never commit `.env` files to version control
- Use different credentials per environment

### 6. Audit Logging

**Status**: ⚠️ NOT IMPLEMENTED

**Required Actions**:

```typescript
function auditLog(action: string, userId: string, details: any) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    action,
    userId,
    details,
    ip: req.ip,
  }));
}

// Log all replay operations
app.post('/internal/indexer/events/replay', async (req, res) => {
  auditLog('replay_started', req.user.id, {
    contract_id: req.body.contract_id,
    ledger: req.body.ledger,
  });
  
  // ... rest of handler
});
```

## Security Testing

### Automated Tests

Run security-focused tests:

```bash
# SQL injection prevention tests
pnpm test -- --testNamePattern="SQL Injection"

# Input validation tests
pnpm test -- --testNamePattern="Input Validation"

# Concurrent operation tests
pnpm test -- --testNamePattern="Concurrent"
```

### Manual Security Review Checklist

- [ ] All database queries use parameterized statements
- [ ] Input validation on all endpoints
- [ ] Authentication enabled on `/internal/*` endpoints
- [ ] Rate limiting configured
- [ ] IP whitelisting enabled (if applicable)
- [ ] HTTPS/TLS enabled
- [ ] Secrets stored securely (not in code)
- [ ] Audit logging enabled
- [ ] Error messages don't leak sensitive information
- [ ] Database credentials have minimal required permissions

## Vulnerability Reporting

If you discover a security vulnerability, please:

1. **DO NOT** open a public GitHub issue
2. Email security@yourcompany.com with details
3. Include steps to reproduce
4. Allow 90 days for patching before public disclosure

## Database Security

### Principle of Least Privilege

The database user should have minimal permissions:

```sql
-- Create dedicated user for indexer
CREATE USER indexer_app WITH PASSWORD 'secure_password';

-- Grant only required permissions
GRANT CONNECT ON DATABASE indexer_db TO indexer_app;
GRANT SELECT, INSERT ON historical_events TO indexer_app;
GRANT SELECT, INSERT ON contract_events TO indexer_app;

-- DO NOT grant DELETE, DROP, or superuser privileges
```

### Connection Security

- Use SSL/TLS for database connections
- Rotate credentials regularly
- Use connection pooling with limits
- Monitor for unusual query patterns

### Data Protection

- Encrypt sensitive data at rest
- Use PostgreSQL row-level security if needed
- Regular backups with encryption
- Test backup restoration procedures

## Monitoring & Alerting

Set up alerts for:
- Failed authentication attempts
- Unusual replay patterns (frequency, size)
- Database connection errors
- High memory/CPU usage
- Slow query performance

## Compliance

Depending on your use case, consider:
- **GDPR**: If processing EU user data
- **SOC 2**: For service providers
- **PCI DSS**: If handling payment data
- **HIPAA**: If handling health data

## Security Updates

- Keep dependencies updated: `pnpm audit`
- Monitor security advisories for PostgreSQL
- Subscribe to Node.js security releases
- Review and update this policy quarterly

## Contact

For security questions or concerns:
- Email: security@yourcompany.com
- Security team: [Your security team contact]

---

**Last Updated**: 2026-05-28
**Next Review**: 2026-08-28
