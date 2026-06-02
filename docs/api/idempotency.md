# Idempotency

Fluxora Backend supports idempotency for POST requests to ensure that replaying a request with the same `Idempotency-Key` returns the exact same response without re-executing the underlying business logic.

## How it Works

1. **First Request**: The client sends a `POST` request with a unique `Idempotency-Key` header.
2. **Hashing**: The backend computes a SHA-256 hash of the canonicalized request body (keys sorted, whitespace stripped).
3. **Storage**: The backend stores the hash along with the full HTTP response (status code and body) in a Redis-backed store (or in-memory for local development).
4. **Subsequent Requests**: If a request with the same `Idempotency-Key` is received:
   - If the incoming body hash matches the stored hash, the cached response is returned with the header `Idempotency-Replayed: true`.
   - If the incoming body hash does **not** match the stored hash, a `409 Conflict` is returned.

## Conflict Detection

If an `Idempotency-Key` is reused with a different request body, the API returns a `409 Conflict` to prevent accidental execution of different operations under the same key.

### 409 Conflict Response

```json
{
  "error": "idempotency_conflict",
  "stored_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "incoming_hash": "84882194165f12e84865f1a50c60832f05929680a6b72d244983057e62d4994d"
}
```

## Constraints

- **Method**: Idempotency is only supported for `POST` requests.
- **Header**: `Idempotency-Key` must be between 1 and 128 characters and contain only `A-Z a-z 0-9 : _ -`.
- **TTL**: Idempotency records are typically stored for 24 hours.

## Canonicalization

To ensure consistent hashing, the request body is normalized before hashing:
- All object keys are sorted alphabetically.
- All unnecessary whitespace is removed.
- Nested objects and arrays are normalized recursively.
