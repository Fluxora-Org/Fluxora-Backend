# CCPA/BIPA Privacy Consent Endpoints

This document describes the CCPA/BIPA recipient consent preference API and data model in `fluxora-backend`.

## Overview

Recipients of streaming payments on Fluxora may record privacy preferences (such as CCPA analytics/marketing opt-outs and BIPA biometric processing consent). These preferences are stored in the `privacy_consents` table and can be queried by other subsystems to enforce privacy choices.

To ensure compliance with zero-PII storage principles:
- Plaintext Stellar public keys are accepted **only at the API boundary**.
- Keys are converted to a deterministic HMAC-SHA256 hash using `computeAddressHash(address, pgcryptoKey)` before database lookup or persistence.
- Neither plaintext Stellar addresses nor address hashes are returned in API responses.

---

## Data Model & Schema

### Database Table: `privacy_consents`

Created via migration `migrations/20260725000000_privacy_consents.ts`.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `address_hash` | `text` | `PRIMARY KEY` | HMAC-SHA256 digest of recipient Stellar address computed via `computeAddressHash`. |
| `analytics_optout` | `boolean` | `NOT NULL`, `DEFAULT false` | CCPA-style opt-out for analytics processing. |
| `marketing_optout` | `boolean` | `NOT NULL`, `DEFAULT false` | CCPA-style opt-out for marketing profiling/communications. |
| `biometric_processing_consent` | `boolean` | `NOT NULL`, `DEFAULT false` | BIPA-style affirmative consent for biometric processing. |
| `created_at` | `timestamptz` | `NOT NULL`, `DEFAULT current_timestamp` | Timestamp when consent record was first created. |
| `updated_at` | `timestamptz` | `NOT NULL`, `DEFAULT current_timestamp` | Timestamp when consent record was last updated. |

---

## API Endpoints

### 1. Upsert Consent Preferences

**`PUT /api/privacy/consent`**

Upserts consent preferences for a recipient Stellar address. Writes are idempotent (last-write-wins; updates `updated_at`).

#### Request Headers

```http
Content-Type: application/json
```

#### Request Body Schema (`PrivacyConsentSchema`)

```json
{
  "address": "GAG6S322PSTN7N6WGAO57O2B7VUXR57WCS72VTLGXR2V4YOWHNYYXY5Z",
  "analytics_optout": true,
  "marketing_optout": false,
  "biometric_processing_consent": true
}
```

- **`address`**: Valid Stellar public key starting with `G` followed by 55 base-32 characters.
- **`analytics_optout`**: Boolean opt-out indicator for analytics.
- **`marketing_optout`**: Boolean opt-out indicator for marketing.
- **`biometric_processing_consent`**: Boolean affirmative consent for biometric processing.

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": {
    "consent": {
      "analytics_optout": true,
      "marketing_optout": false,
      "biometric_processing_consent": true,
      "created_at": "2026-07-25T14:00:00.000Z",
      "updated_at": "2026-07-25T14:00:00.000Z"
    }
  }
}
```

#### Response Headers

```http
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

---

### 2. Fetch Consent Preferences

**`GET /api/privacy/consent/:address`**

Retrieves recorded consent preferences for a recipient by hashing the route parameter and querying `privacy_consents`.

#### Request Parameters

- **`:address`** *(path parameter)*: Valid Stellar public key.

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": {
    "consent": {
      "analytics_optout": true,
      "marketing_optout": false,
      "biometric_processing_consent": true,
      "created_at": "2026-07-25T14:00:00.000Z",
      "updated_at": "2026-07-25T14:00:00.000Z"
    }
  }
}
```

#### Error Responses

- **`400 Bad Request`** (`VALIDATION_ERROR`): Provided Stellar address is malformed or invalid.
- **`404 Not Found`** (`NOT_FOUND`): No consent record found for the address.
- **`405 Method Not Allowed`** (`METHOD_NOT_ALLOWED`): Invalid HTTP verb (e.g. POST, DELETE). Exposes `Allow` header.
- **`503 Service Unavailable`** (`SERVICE_UNAVAILABLE`): Database pool exhausted or `pgcryptoKey` unconfigured.

---

## Security & Architecture Notes

1. **Deterministic HMAC Hashing**: Uses `crypto.createHmac('sha256', pgcryptoKey)` matching `src/pii/pgcryptoEncryption.ts` so lookup matches stream PII encryption strategy without storing plaintext.
2. **Fail-Closed Strategy**: If `pgcryptoKey` is missing or empty, handlers fail closed with `503 Service Unavailable` rather than storing or operating on plaintext addresses.
3. **No Intermediate Caching**: All consent endpoints enforce `Cache-Control: no-store` to prevent proxy/CDN caching of recipient state.
