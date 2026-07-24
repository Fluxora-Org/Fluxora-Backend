# Debezium CDC Connector for Streams

This guide documents the proof-of-concept configuration and operational setup for streaming change-data-capture (CDC) events from the Fluxora `streams` PostgreSQL database table using Debezium.

By using CDC events instead of polling the REST API, downstream systems can consume stream-lifecycle changes (such as creations, updates, or status changes) in real time with minimal database overhead and sub-millisecond latency.

---

## Connector Configuration

The proof-of-concept configuration is stored in [debezium-connector.json](file:///c:/Users/USER/Fluxora-Backend/docs/integrations/debezium-connector.json). 

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

---

## Security Model & PII Exclusions

### Rationale for Default Exclusion
To enforce a "fail-closed" security posture, the `sender_address` and `recipient_address` columns are excluded from the Kafka topic by default using `"column.exclude.list"`.

1. **Plaintext Leakage Risk**: Stellar addresses are considered Personally Identifiable Information (PII) under the system's privacy standards. CDC topics are frequently consumed by multiple downstream databases, indexing systems, and analytics consumers with weaker access controls. Exposing plaintext addresses violates data isolation.
2. **Ciphertext Security**: While the database encrypts these columns via `pgcrypto` using `pgp_sym_encrypt` (AES-256), transmitting raw ciphertext over CDC is highly discouraged:
   - **Exposures**: It exposes encrypted ciphertexts to long-term storage in Kafka brokers where keys might be rotated, leaving legacy ciphertexts decryptable if keys are compromised in the future.
   - **Utility**: The raw ciphertext values are completely unusable to downstream systems without key access.
3. **Fail-Closed Strategy**: It is safer to require explicit configuration and permission for systems needing access to these fields, rather than broadcasting them by default.

---

## PII Masking and Decryption Guidance

If a downstream service has a verified requirement to process the sender or recipient addresses, use one of the following methods:

### Option A: Cryptographic Hash Tracking (Recommended)
By default, the `sender_address_hash` and `recipient_address_hash` columns (HMAC-SHA256 digests) are **not** excluded. Downstream systems can use these hashes to:
- Group transactions/streams by the same sender/recipient.
- Perform high-speed lookups against internal systems that already know the addresses and can compute matching hashes.

This provides full correlation capabilities without ever exposing the raw address or ciphertext.

### Option B: Value Masking (Alternative to Exclusion)
If downstream consumers require the columns to exist in the payload but want them redacted or replaced with a safe pattern, you can use the built-in Kafka Connect `MaskField` Single Message Transformation (SMT):

Remove the columns from `column.exclude.list` and add the following SMT rules to the connector config:
```json
{
  "transforms": "maskAddresses",
  "transforms.maskAddresses.type": "org.apache.kafka.connect.transforms.MaskField$Value",
  "transforms.maskAddresses.fields": "sender_address,recipient_address",
  "transforms.maskAddresses.replacement": "MASKED"
}
```

Alternatively, you can use Debezium's built-in character masking property:
```json
{
  "column.mask.with.8.chars": "public.streams.sender_address,public.streams.recipient_address"
}
```
This replaces the values with `********`.

### Option C: Decrypting CDC Payloads
Downstream consumers that are explicitly authorized to read raw Stellar addresses must decrypt the data on the client side:
1. **Fetch Encryption Key**: Retrieve the active `PGCRYPTO_KEY` from a secure vault (e.g., AWS Secrets Manager, HashiCorp Vault).
2. **Decrypt Payload**:
   - The ciphertexts are armored PGP messages (`-----BEGIN PGP MESSAGE-----`).
   - Use standard openPGP library/AES decryption with the secret key to decrypt the payload on the client side.
   - *Never* store the decryption key inside the Kafka Connect server configuration files or logs.

---

## Deployment & Verification

### 1. Prerequisites
- **PostgreSQL**: Ensure `wal_level = replica` is configured in `postgresql.conf`.
- **Kafka Connect**: Ensure Debezium PostgreSQL connector plugin is installed.

### 2. Register Connector
Deploy the configuration JSON to your Kafka Connect cluster:
```bash
curl -X POST -H "Content-Type: application/json" \
  --data @docs/integrations/debezium-connector.json \
  http://localhost:8083/connectors
```

### 3. Verify Connector Status
```bash
curl -s http://localhost:8083/connectors/fluxora-streams-cdc-connector/status | jq
```

### 4. Monitor Kafka Topic
Verify that events are published without PII leakage (the message value should contain the schema and fields, but omit `sender_address` and `recipient_address` entirely):
```bash
kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic fluxora-db.public.streams \
  --from-beginning
```
