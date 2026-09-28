/**
 * Secret pattern deny-list for observability channels.
 *
 * Complements `sanitizer.ts` (field-name + PII redaction) with value-shape
 * detection for credentials that commonly leak into free-form log lines,
 * trace attributes, and Prometheus metric labels:
 *   - API keys
 *   - Webhook signing secrets
 *   - Database connection credentials
 *   - OIDC / OAuth client secrets
 *
 * Every pattern below MUST be covered by `tests/pii/secret-observability.test.ts`.
 */

export const REDACTED_SECRET = '[REDACTED_SECRET]';

export interface SecretPattern {
  /** Stable identifier used in tests and diagnostics. */
  id: string;
  /** Human-readable secret class (matches the issue acceptance criteria). */
  kind: 'api_key' | 'webhook_secret' | 'database_credential' | 'oidc_client_secret';
  /** Global regex that matches the secret value (or value-bearing fragment). */
  pattern: RegExp;
  /** Replacement applied when the pattern matches. */
  replacement: string;
}

/**
 * Deny-list of secret value shapes. Keep patterns specific enough to avoid
 * false positives on ordinary identifiers while still catching production
 * credential formats used by Fluxora.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'api_key_prefixed',
    kind: 'api_key',
    // Fluxora / Stripe-style live or test API keys (sk_live_…, pk_test_…, flux_live_…).
    pattern: /\b(?:sk|pk|rk|flux)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    id: 'api_key_assignment',
    kind: 'api_key',
    pattern: /\b(?:api[_-]?key|x-api-key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/gi,
    replacement: 'api_key: [REDACTED_SECRET]',
  },
  {
    id: 'webhook_secret_prefixed',
    kind: 'webhook_secret',
    // Stripe-style webhook signing secrets and generic whsec_ tokens.
    pattern: /\bwhsec_[A-Za-z0-9_\-+/=]{16,}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    id: 'webhook_secret_assignment',
    kind: 'webhook_secret',
    pattern: /\b(?:webhook[_-]?secret|signing[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{12,}['"]?/gi,
    replacement: 'webhook_secret: [REDACTED_SECRET]',
  },
  {
    id: 'database_url_with_password',
    kind: 'database_credential',
    // postgres://user:password@host / mysql://… / mongodb://…
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s]+:[^@\s]+@[^\s'"]+/gi,
    replacement: '[REDACTED_SECRET_DB_URL]',
  },
  {
    id: 'database_password_assignment',
    kind: 'database_credential',
    pattern: /\b(?:database[_-]?password|db[_-]?password|pgpassword)\s*[:=]\s*['"]?[^\s'"]{4,}['"]?/gi,
    replacement: 'database_password: [REDACTED_SECRET]',
  },
  {
    id: 'oidc_client_secret',
    kind: 'oidc_client_secret',
    pattern: /\b(?:oidc[_-]?client[_-]?secret|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{12,}['"]?/gi,
    replacement: 'client_secret: [REDACTED_SECRET]',
  },
  {
    id: 'oidc_client_secret_value',
    kind: 'oidc_client_secret',
    // Standalone OIDC client secret tokens commonly prefixed in env/docs.
    pattern: /\boidc_cs_[A-Za-z0-9_\-+/=]{16,}\b/g,
    replacement: REDACTED_SECRET,
  },
] as const;

/** Representative samples of every secret kind — used by contract tests. */
export const SECRET_TEST_SAMPLES: Readonly<Record<SecretPattern['kind'], string>> = {
  api_key: 'flux_live_a1b2c3d4e5f6g7h8i9j0k1l2',
  webhook_secret: 'whsec_9f8e7d6c5b4a3210fedcba98',
  database_credential: 'postgres://fluxora:S3cretP@ssw0rd@db.internal:5432/fluxora',
  oidc_client_secret: 'oidc_cs_Zm9vYmFyYmF6cXV4MTIzNDU2',
};

/**
 * Returns true when `value` matches any entry in the secret deny-list.
 */
export function containsSecret(value: string): boolean {
  if (!value) return false;
  for (const entry of SECRET_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(value)) {
      entry.pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/**
 * Redact every deny-listed secret shape found in a free-form string.
 * Safe to call repeatedly (already-redacted markers do not re-match).
 */
export function redactSecretsInString(input: string): string {
  if (!input) return input;
  let out = input;
  for (const entry of SECRET_PATTERNS) {
    entry.pattern.lastIndex = 0;
    out = out.replace(entry.pattern, entry.replacement);
    entry.pattern.lastIndex = 0;
  }
  return out;
}

/**
 * Deep-scan a value (string / array / plain object) and redact secret shapes
 * in every string leaf. Used for trace attributes and structured log meta.
 */
export function redactSecretsDeep<T>(value: T): T {
  return redactDeep(value) as T;
}

function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecretsInString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Field names that are themselves secret-bearing always redact the value.
      const keyLower = k.toLowerCase();
      if (
        keyLower.includes('secret') ||
        keyLower.includes('password') ||
        keyLower === 'authorization' ||
        keyLower === 'api_key' ||
        keyLower === 'apikey' ||
        keyLower === 'client_secret' ||
        keyLower === 'clientsecret'
      ) {
        out[k] = typeof v === 'string' && !String(v).includes('REDACTED')
          ? REDACTED_SECRET
          : typeof v === 'string'
            ? v
            : REDACTED_SECRET;
        // Still run shape redaction in case value was nested later.
        if (typeof out[k] === 'string') {
          out[k] = redactSecretsInString(out[k] as string);
        }
        continue;
      }
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize Prometheus / OTel metric labels so secret values can never become
 * label cardinality keys. Non-string values are stringified then redacted.
 */
export function sanitizeMetricLabels<T extends Record<string, string | number | boolean>>(
  labels: T,
): { [K in keyof T]: string } {
  const out = {} as { [K in keyof T]: string };
  for (const key of Object.keys(labels) as Array<keyof T>) {
    const raw = labels[key];
    const asString = typeof raw === 'string' ? raw : String(raw);
    const keyLower = String(key).toLowerCase();
    if (
      keyLower.includes('secret') ||
      keyLower.includes('password') ||
      keyLower.includes('token') ||
      keyLower.includes('api_key') ||
      keyLower.includes('apikey') ||
      keyLower.includes('authorization') ||
      keyLower.includes('credential')
    ) {
      out[key] = REDACTED_SECRET;
      continue;
    }
    out[key] = containsSecret(asString) ? REDACTED_SECRET : redactSecretsInString(asString);
  }
  return out;
}

/**
 * Assert helper for tests: serialize `value` and ensure no raw secret sample
 * (or live deny-list match beyond redaction markers) is present.
 */
export function assertNoSecrets(value: unknown, samples: readonly string[] = Object.values(SECRET_TEST_SAMPLES)): void {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  for (const sample of samples) {
    if (serialized.includes(sample)) {
      throw new Error(`Secret value escaped into observability output: ${sample.slice(0, 12)}…`);
    }
  }
  // Also reject any still-matching deny-list shape (catches variants).
  if (containsSecret(serialized.replace(/\[REDACTED(?:_SECRET(?:_DB_URL)?)?\]/g, ''))) {
    throw new Error('Deny-listed secret pattern still present after redaction markers removed');
  }
}
