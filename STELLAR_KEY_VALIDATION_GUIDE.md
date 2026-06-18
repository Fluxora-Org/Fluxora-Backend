# Stellar Public Key Validation - Quick Reference

## What Changed?

The Fluxora Backend API now validates that all `sender` and `recipient` fields contain valid Stellar public keys.

## Valid Stellar Public Key Format

```
G[A-Z2-7]{55}
```

- **Starts with:** `G`
- **Followed by:** Exactly 55 characters from the base32 alphabet
- **Base32 alphabet:** `A-Z` (uppercase) and `2-7` (digits)
- **Total length:** 56 characters

### Valid Examples
```
GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7
GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR
GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX
```

### Invalid Examples
```
GABC123                                                    ❌ Too short
AAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7  ❌ Wrong prefix (A instead of G)
G1111111111111111111111111111111111111111111111111111111  ❌ Invalid character (1 not in base32)
not-a-stellar-key                                          ❌ Not a Stellar key
                                                           ❌ Empty string
```

## API Request Example

### Valid Request
```bash
curl -X POST http://localhost:3000/api/streams \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{
    "sender": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    "recipient": "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
    "depositAmount": "1000",
    "ratePerSecond": "10",
    "startTime": 1700000000
  }'
```

**Response:** `201 Created`
```json
{
  "id": "stream-1234567890-abc12",
  "sender": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
  "recipient": "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
  "depositAmount": "1000",
  "ratePerSecond": "10",
  "startTime": 1700000000,
  "endTime": 0,
  "status": "active"
}
```

### Invalid Request
```bash
curl -X POST http://localhost:3000/api/streams \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-key-456" \
  -d '{
    "sender": "invalid-key",
    "recipient": "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
    "depositAmount": "1000",
    "ratePerSecond": "10"
  }'
```

**Response:** `400 Bad Request`
```json
{
  "error": "Validation failed",
  "details": "sender must be a valid Stellar public key (G...)",
  "status": 400
}
```

## Error Messages

| Scenario | Error Message |
|----------|---------------|
| Missing sender | `sender is required` |
| Empty sender | `sender must be a valid Stellar public key (G...)` |
| Invalid format | `sender must be a valid Stellar public key (G...)` |
| Missing recipient | `recipient is required` |
| Empty recipient | `recipient must be a valid Stellar public key (G...)` |
| Invalid format | `recipient must be a valid Stellar public key (G...)` |

## For Developers

### Validation Logic Location
- **Schema Definition:** `src/validation/schemas.ts`
- **Route Integration:** `src/routes/streams.ts`
- **Tests:** `tests/routes/streams.test.ts`
- **API Docs:** `openapi.yaml`

### Regex Pattern
```typescript
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
```

### Zod Schema
```typescript
function stellarPublicKeyField(fieldName: string) {
  return z
    .string({
      required_error: `${fieldName} is required`,
      invalid_type_error: `${fieldName} must be a string`,
    })
    .min(1, `${fieldName} must be a non-empty string`)
    .regex(STELLAR_PUBLIC_KEY_REGEX, `${fieldName} must be a valid Stellar public key (G...)`);
}
```

### Testing
```typescript
// Valid keys for testing
const VALID_SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

// Invalid keys for testing
const INVALID_SHORT = 'GABC123';
const INVALID_PREFIX = 'AAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const INVALID_CHARS = 'G1111111111111111111111111111111111111111111111111111111';
```

## Migration Checklist

If you're integrating with this API:

- [ ] Verify all sender addresses are valid Stellar public keys
- [ ] Verify all recipient addresses are valid Stellar public keys
- [ ] Update error handling to catch 400 validation errors
- [ ] Test with both valid and invalid keys
- [ ] Update documentation/examples with valid keys

## Resources

- [Stellar Public Key Format](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/accounts)
- [Base32 Encoding](https://en.wikipedia.org/wiki/Base32)
- [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test) - Generate test keys

## Support

For issues or questions:
1. Check the error message for specific validation failures
2. Verify your key format matches the regex pattern
3. Test with known valid keys from Stellar testnet
4. Review the OpenAPI spec at `/openapi.yaml`
