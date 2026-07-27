# Debezium CDC Connector for Streams

This guide documents the proof-of-concept configuration and operational setup for streaming change-data-capture (CDC) events from the Fluxora `streams` PostgreSQL database table using Debezium.

By using CDC events instead of polling the REST API, downstream systems can consume stream-lifecycle changes (such as creations, updates, or status changes) in real time with minimal database overhead and sub-millisecond latency.

**Security Notice**: This configuration implements a fail-closed security posture by default, excluding PII-encrypted address columns from CDC topics to prevent accidental data leakage.

---

## Table Schema Reference

The `streams` table is defined in `init-db/01-schema.sql` and contains the following columns:

| Column | Type | Description | PII Status |
|--------|------|-------------|------------|
| `id` | TEXT | Primary key | No |
| `sender_address` | TEXT | Stellar address (encrypted) | **PII - Excluded** |
| `sender_address_hash` | TEXT | HMAC-SHA256 hash of sender address | No (safe for correlation) |
| `recipient_address` | TEXT | Stellar address (encrypted) | **PII - Excluded** |
| `recipient_address_hash` | TEXT | HMAC-SHA256 hash of recipient address | No (safe for correlation) |
| `amount` | TEXT | Stream amount | No |
| `streamed_amount` | TEXT | Amount already streamed | No |
| `remaining_amount` | TEXT | Remaining amount | No |
| `rate_per_second` | TEXT | Streaming rate | No |
| `start_time` | BIGINT | Unix timestamp | No |
| `end_time` | BIGINT | Unix timestamp | No |
| `status` | TEXT | Stream status | No |
| `contract_id` | TEXT | Contract identifier | No |
| `transaction_hash` | TEXT | Transaction hash | No |
| `event_index` | INTEGER | Event index | No |
| `created_at` | TIMESTAMP | Creation timestamp | No |
| `updated_at` | TIMESTAMP | Last update timestamp | No |
| `metadata` | JSONB | Additional metadata | No |

---

## Connector Configuration

The proof-of-concept configuration is stored in [`debezium-connector.json`](./debezium-connector.json).

```json
{
  "name": "fluxora-streams-cdc-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "tasks.max": "1",
    "plugin.name": "pgoutput",
    "database.hostname": "localhost",
    "database.port": "5432",
    "database.user": "indexer_user",
    "database.password": "indexer_password",
    "database.dbname": "indexer_db",
    "database.server.name": "fluxora-db",
    "table.include.list": "public.streams",
    "column.exclude.list": "public.streams.sender_address,public.streams.recipient_address",
    "decimal.handling.mode": "double",
    "time.precision.mode": "connect"
  }
}
```

### Configuration Validation

The configuration is automatically validated by the test suite in `tests/integration/debeziumConfig.validate.test.ts` to ensure:

1. **JSON Syntax**: The configuration file is valid JSON
2. **Column References**: All referenced columns exist in the `streams` table
3. **PII Protection**: Sender and recipient address columns are properly excluded
4. **Table Inclusion**: The `public.streams` table is correctly included

---

## Security Model & PII Exclusions

### Why PII Columns Are Excluded by Default

To enforce a "fail-closed" security posture, the `sender_address` and `recipient_address` columns are excluded from the Kafka topic by default using `"column.exclude.list"`.

#### 1. Data Classification

According to the Fluxora PII policy (`src/pii/policy.ts`), Stellar addresses are classified as **SENSITIVE** data:

- **Correlation Risk**: While Stellar public keys don't directly identify individuals, they can be correlated with exchange KYC records or on-chain activity
- **Regulatory Compliance**: GDPR and privacy regulations require explicit consent for processing pseudonymous identifiers
- **Data Isolation**: CDC topics are consumed by multiple downstream systems with varying access controls

#### 2. Encryption Protection

The database encrypts address columns using `pgcrypto` with `pgp_sym_encrypt` (AES-256):

```typescript
// From src/pii/pgcryptoEncryption.ts
export const PGP_SYM_ENCRYPT_OPTIONS = 'cipher-algo=aes256,compress-algo=0,armor';
```

**However, transmitting ciphertext over CDC is strongly discouraged**:

- **Key Rotation Risk**: Ciphertext stored in Kafka may become decryptable if keys are compromised in the future
- **Limited Utility**: Raw ciphertext is unusable to downstream systems without key access
- **Compliance Violation**: Storing encrypted PII in external systems may violate data minimization principles

#### 3. Fail-Closed Strategy

The configuration implements defense-in-depth:

- **Default Exclusion**: PII columns are excluded unless explicitly enabled
- **Explicit Opt-in**: Systems needing address access must request and justify access
- **Audit Trail**: Any changes to PII handling are logged and reviewed

---

## PII Masking and Decryption Guidance

If a downstream service has a verified requirement to process the sender or recipient addresses, use one of the following methods:

### Option A: Cryptographic Hash Tracking (Recommended)

**Security Level**: Maximum protection with correlation capability

By default, the `sender_address_hash` and `recipient_address_hash` columns (HMAC-SHA256 digests) are **not** excluded. Downstream systems can use these hashes to:

- **Group streams** by the same sender/recipient
- **Perform high-speed lookups** against internal systems that already know the addresses
- **Maintain correlation** without ever exposing raw addresses

**Implementation**:
```sql
-- Hash computation uses HMAC-SHA256 with a server-side key
-- Example: computeAddressHash(address, key) from src/pii/pgcryptoEncryption.ts
```

**Advantages**:
- No raw addresses exposed in CDC topic
- Full correlation capability maintained
- Compliant with data minimization principles
- Safe for multi-consumer environments

### Option B: Value Masking (Alternative to Exclusion)

**Security Level**: Moderate protection with schema preservation

If downstream consumers require the columns to exist in the payload but want them redacted or replaced with a safe pattern, use Kafka Connect's built-in Single Message Transformation (SMT):

**Method 1: MaskField SMT**
```json
{
  "transforms": "maskAddresses",
  "transforms.maskAddresses.type": "org.apache.kafka.connect.transforms.MaskField$Value",
  "transforms.maskAddresses.fields": "sender_address,recipient_address",
  "transforms.maskAddresses.replacement": "MASKED"
}
```

**Method 2: Debezium Character Masking**
```json
{
  "column.mask.with.8.chars": "public.streams.sender_address,public.streams.recipient_address"
}
```

This replaces the values with `********`.

**When to Use**:
- Schema compatibility required for downstream processing
- Partial data needed (e.g., address length, format)
- Testing and development environments

### Option C: Authorized Decryption (Restricted Access)

**Security Level**: Full access with strict controls

Downstream consumers that are **explicitly authorized** to read raw Stellar addresses must:

1. **Authorization Requirements**:
   - Written justification approved by security team
   - Data processing agreement (DPA) in place
   - Audit logging of all access

2. **Technical Implementation**:
   ```typescript
   // From src/pii/pgcryptoEncryption.ts
   export function pgpDecryptAddressColumn(
     columnName: string,
     keyParamIndex: number,
     previousKeyParamIndex?: number,
   ): string {
     const previousArg = previousKeyParamIndex !== undefined ? `$${previousKeyParamIndex}` : 'NULL';
     return `decrypt_stream_address(${columnName}, $${keyParamIndex}, ${previousArg}) AS ${columnName}`;
   }
   ```

3. **Key Management**:
   - Fetch encryption key from secure vault (AWS Secrets Manager, HashiCorp Vault)
   - Never store keys in Kafka Connect configuration
   - Rotate keys regularly and re-encrypt historical data

4. **Client-Side Decryption**:
   - Use standard OpenPGP library with AES-256 decryption
   - Decrypt only what's needed for processing
   - Never persist decrypted addresses to logs or external storage

---

## Deployment & Verification

### 1. Prerequisites

**PostgreSQL Configuration**:
```bash
# Ensure WAL level supports logical replication
wal_level = replica

# Verify pgoutput plugin is available
SELECT * FROM pg_available_extensions WHERE name = 'pgoutput';
```

**Kafka Connect Setup**:
- Debezium PostgreSQL connector plugin installed
- Connector has read access to the database
- Appropriate Kafka topics permissions

### 2. Register Connector

```bash
# Deploy configuration to Kafka Connect cluster
curl -X POST -H "Content-Type: application/json" \
  --data @docs/integrations/debezium-connector.json \
  http://localhost:8083/connectors

# Or using the REST API with authentication
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  --data @docs/integrations/debezium-connector.json \
  http://kafka-connect:8083/connectors
```

### 3. Verify Connector Status

```bash
# Check connector health
curl -s http://localhost:8083/connectors/fluxora-streams-cdc-connector/status | jq

# Expected output should show:
# - "state": "RUNNING"
# - "worker_id": "<hostname>"
```

### 4. Monitor Kafka Topic

Verify that events are published without PII leakage:

```bash
# Consume messages and inspect schema
kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic fluxora-db.public.streams \
  --from-beginning \
  --property print.schema=true

# Verify sender_address and recipient_address are absent
kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic fluxora-db.public.streams \
  --from-beginning | jq '.payload.sender_address // "ABSENT"'
```

### 5. Test Data Flow

```sql
-- Insert test stream (sender_address will be encrypted in DB)
INSERT INTO streams (
  id, sender_address, recipient_address, amount, 
  status, contract_id, transaction_hash, event_index
) VALUES (
  'test-stream-001',
  'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
  '1000.00',
  'active',
  'contract-123',
  'tx-hash-456',
  1
);

-- Verify CDC event excludes PII columns
-- Check Kafka consumer output
```

---

## Troubleshooting

### Common Issues

1. **Connector Fails to Start**
   - Verify `wal_level = replica` in PostgreSQL
   - Check database user has replication privileges
   - Ensure `pgoutput` plugin is installed

2. **No CDC Events Received**
   - Verify table is in `table.include.list`
   - Check PostgreSQL replication slots
   - Confirm Kafka topic exists and is accessible

3. **PII Columns Appear in Topic**
   - Verify `column.exclude.list` is correctly formatted
   - Check for typos in column names (case-sensitive)
   - Restart connector after configuration changes

### Security Validation

Run the validation test suite to ensure configuration integrity:

```bash
pnpm test tests/integration/debeziumConfig.validate.test.ts
```

This validates:
- JSON syntax correctness
- Column references exist in schema
- PII columns are properly excluded
- Table inclusion configuration

---

## Security Notes

### Data Protection Principles

1. **Data Minimization**: Only necessary data is included in CDC topics
2. **Purpose Limitation**: Address data is only processed when explicitly authorized
3. **Storage Limitation**: Encrypted data is not persisted in external systems
4. **Integrity**: Hash columns maintain correlation without exposing PII

### Compliance Considerations

- **GDPR**: Address data requires explicit consent for processing
- **SOC-2**: Access controls and audit logging required
- **CCPA**: Right to deletion must be supported (see `redactPiiForAddress` in `src/pii/pgcryptoEncryption.ts`)

### Monitoring and Alerting

Monitor for:
- Unauthorized access attempts to PII columns
- Configuration changes to `column.exclude.list`
- Kafka topic schema evolution
- Connector state changes

---

## Testing

Run the comprehensive test suite:

```bash
# Run Debezium configuration validation tests
pnpm test tests/integration/debeziumConfig.validate.test.ts

# Run all integration tests
pnpm test tests/integration/

# Run with coverage
pnpm test:coverage
```

The test suite validates:
- ✅ JSON syntax validation
- ✅ Column existence verification
- ✅ PII column exclusion
- ✅ Schema compatibility
- ✅ Security configuration
