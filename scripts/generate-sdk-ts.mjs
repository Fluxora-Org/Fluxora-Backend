#!/usr/bin/env node
/**
 * TypeScript Client SDK generator for Fluxora Backend.
 *
 * Reads `openapi.yaml` (the authoritative spec) and emits a fully-typed
 * TypeScript client under `sdk/typescript/`.
 *
 * Usage:
 *   node scripts/generate-sdk-ts.mjs [--check] [--out-dir <path>] [--spec <path>]
 *
 * Options:
 *   --check     Drift-check mode. Compares generated output against disk.
 *               Exits 0 when identical; exits 1 on any mismatch or missing file.
 *               Used by CI to catch spec/SDK divergence automatically.
 *   --out-dir   Output directory (default: sdk/typescript).
 *   --spec      Path to openapi.yaml (default: openapi.yaml).
 *
 * @security Generated files contain no credentials or secrets. Bearer tokens
 *   and API keys flow through the SDK client at runtime only and are never
 *   logged or embedded in generated artifacts.
 *
 * @module scripts/generate-sdk-ts
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isCheckMode = args.includes('--check');

let outDirArg = 'sdk/typescript';
const outDirIdx = args.indexOf('--out-dir');
if (outDirIdx !== -1 && args[outDirIdx + 1]) outDirArg = args[outDirIdx + 1];

let specPathArg = 'openapi.yaml';
const specIdx = args.indexOf('--spec');
if (specIdx !== -1 && args[specIdx + 1]) specPathArg = args[specIdx + 1];

const ROOT_DIR = process.cwd();
const SPEC_PATH = path.resolve(ROOT_DIR, specPathArg);
const OUT_DIR = path.resolve(ROOT_DIR, outDirArg);

// ── Lightweight YAML parser (OpenAPI 3.x subset) ─────────────────────────────

/**
 * Parse an OpenAPI 3.x YAML file into a plain JS object.
 *
 * Supports the subset used by Fluxora's openapi.yaml:
 * - Block mappings and sequences.
 * - Multi-line scalar values (literal `|` and folded `>`).
 * - Quoted and unquoted string scalars.
 * - Boolean, integer, float, and null literals.
 * - Inline arrays: `[a, b, c]`.
 * - `#` line comments.
 *
 * @security This parser only reads the local spec file; it never makes
 *   network requests or executes arbitrary code from the spec.
 *
 * @param {string} yamlString - Raw YAML text.
 * @returns {unknown} Parsed value.
 */
function parseSimpleYaml(yamlString) {
  const lines = yamlString.split(/\r?\n/);
  let lineIdx = 0;

  function getIndent(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }

  function parseBlock(baseIndent) {
    let result = null;
    let isMap = false;
    let isArray = false;

    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) { lineIdx++; continue; }

      const currentIndent = getIndent(line);
      if (currentIndent < baseIndent) break;

      if (trimmed.startsWith('- ')) {
        if (result === null) { result = []; isArray = true; }
        else if (!isArray) break;

        const itemContent = trimmed.slice(2).trim();
        if (itemContent.includes(': ') || (itemContent.endsWith(':') && !itemContent.startsWith("'"))) {
          lines[lineIdx] = ' '.repeat(currentIndent + 2) + itemContent;
          result.push(parseBlock(currentIndent + 2));
        } else {
          result.push(parseScalarValue(itemContent));
          lineIdx++;
        }
      } else if (trimmed.includes(':')) {
        if (result === null) { result = {}; isMap = true; }
        else if (!isMap) break;

        const colonIdx = trimmed.indexOf(':');
        const key = trimmed.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
        let valueStr = trimmed.slice(colonIdx + 1).trim();

        lineIdx++;

        if (valueStr === '|' || valueStr === '>-' || valueStr === '>' || valueStr === '|-') {
          const scalarLines = [];
          const blockIndent = currentIndent + 2;
          while (lineIdx < lines.length) {
            const nextLine = lines[lineIdx];
            if (!nextLine.trim()) { scalarLines.push(''); lineIdx++; continue; }
            if (getIndent(nextLine) < blockIndent) break;
            scalarLines.push(nextLine.slice(blockIndent));
            lineIdx++;
          }
          result[key] = scalarLines.join('\n').trim();
        } else if (!valueStr) {
          if (lineIdx < lines.length && getIndent(lines[lineIdx]) > currentIndent) {
            result[key] = parseBlock(getIndent(lines[lineIdx]));
          } else {
            result[key] = null;
          }
        } else {
          result[key] = parseScalarValue(valueStr);
        }
      } else {
        lineIdx++;
      }
    }
    return result ?? {};
  }

  function parseScalarValue(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null' || val === '~') return null;
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      return val.slice(1, -1);
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      return val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    }
    return val;
  }

  return parseBlock(0);
}

// ── Spec loader ───────────────────────────────────────────────────────────────

/**
 * Load and parse the OpenAPI spec from disk.
 *
 * @param {string} specPath - Absolute path to openapi.yaml.
 * @returns {object} Parsed spec object.
 * @throws {Error} When the file is missing.
 */
function loadSpec(specPath) {
  if (!fs.existsSync(specPath)) {
    throw new Error(`OpenAPI spec file not found: ${specPath}`);
  }
  return parseSimpleYaml(fs.readFileSync(specPath, 'utf8'));
}

// ── File generators ───────────────────────────────────────────────────────────

/**
 * Generate all SDK source files as a { relativePath → fileContent } map.
 *
 * Field names in the generated types intentionally mirror `toApiStream()` in
 * `src/routes/streams.ts` (camelCase: `depositAmount`, `ratePerSecond`, etc.).
 *
 * @param {object} spec - Parsed OpenAPI spec.
 * @returns {Record<string, string>} Map of relative paths to file content.
 */
function generateTypeScriptSdk(spec) {
  const version = spec?.info?.version ?? '0.1.0';
  const files = {};

  files['package.json'] = generatePackageJson(version);
  files['tsconfig.json'] = generateTsConfig();
  files['README.md'] = generateReadme(version);
  files['src/index.ts'] = generateIndex();
  files['src/types.ts'] = generateTypes();
  files['src/errors.ts'] = generateErrors();
  files['src/idempotency.ts'] = generateIdempotency();
  files['src/pagination.ts'] = generatePagination();
  files['src/client.ts'] = generateClient();

  return files;
}

// ── package.json ──────────────────────────────────────────────────────────────

function generatePackageJson(version) {
  return JSON.stringify({
    name: '@fluxora/sdk',
    version,
    description: 'Typed TypeScript client SDK for the Fluxora Backend API — generated from openapi.yaml.',
    main: './src/index.ts',
    module: './src/index.ts',
    types: './src/index.ts',
    exports: {
      '.': {
        types: './src/index.ts',
        import: './src/index.ts',
        require: './src/index.ts',
      },
    },
    files: ['src', 'README.md'],
    license: 'MIT',
    keywords: ['fluxora', 'sdk', 'streaming', 'stellar'],
    dependencies: {},
  }, null, 2) + '\n';
}

// ── tsconfig.json ─────────────────────────────────────────────────────────────

function generateTsConfig() {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src/**/*'],
  }, null, 2) + '\n';
}

// ── README.md ─────────────────────────────────────────────────────────────────

function generateReadme(version) {
  return `# @fluxora/sdk — TypeScript Client SDK

> **Version**: ${version} · **Generated from** \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
> Do not edit by hand — run \`pnpm generate:sdk:ts\` to regenerate.

Typed TypeScript client for the [Fluxora Backend API](../../docs/api.md).
Zero external runtime dependencies; uses the standard Web \`fetch\` API.

---

## Features

| Feature | Detail |
|---------|--------|
| **Zero dependencies** | Uses native \`fetch\` — works in Node.js ≥ 18, Deno, Bun, and browsers |
| **Full type safety** | Every request/response is typed from \`openapi.yaml\` |
| **Cursor pagination** | \`StreamPaginator\` wraps keyset cursors behind an ergonomic async generator |
| **Idempotency** | UUID v4 key generation + canonical SHA-256 body hashing matching the server |
| **Typed error hierarchy** | \`FluxoraApiError\`, \`IdempotencyConflictError\`, \`ValidationError\` |
| **Client-side validation** | Input guards throw \`ValidationError\` before any network round-trip |
| **Auth support** | Bearer JWT + static API key |
| **Deterministic dispatch** | No hidden retries; query params and JSON bodies are sent in caller insertion order |

---

## Installation

This is an internal workspace package declared in \`pnpm-workspace.yaml\`.
Reference it from sibling packages with:

\`\`\`json
{ "dependencies": { "@fluxora/sdk": "workspace:*" } }
\`\`\`

---

## Quickstart

\`\`\`typescript
import {
  FluxoraClient,
  generateIdempotencyKey,
  FluxoraApiError,
  IdempotencyConflictError,
} from '@fluxora/sdk';

const client = new FluxoraClient({
  baseUrl: 'http://localhost:3000',
  bearerToken: process.env.FLUXORA_TOKEN,
});

// Health probe
const health = await client.getHealth();
console.log('Status:', health.status); // 'ok' | 'degraded' | 'shutting_down'

// Create a stream (auto-generates Idempotency-Key)
const stream = await client.createStream({
  sender:        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  recipient:     'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
  depositAmount: '1000000.0000000',
  ratePerSecond: '0.0000116',
  startTime:     Math.floor(Date.now() / 1000),
});
console.log('Stream:', stream.id, stream.status);

// Paginate all active streams
const paginator = client.listStreams({ limit: 20, status: 'active' });
for await (const s of paginator.autoPaginate()) {
  console.log(s.id, s.depositAmount);
}
\`\`\`

---

## Error handling

\`\`\`typescript
import { FluxoraApiError, IdempotencyConflictError, ValidationError } from '@fluxora/sdk';

try {
  await client.createStream(payload, 'my-idempotency-key');
} catch (err) {
  if (err instanceof IdempotencyConflictError) {
    // Same key, different payload — generate a new key
    console.error('Conflict:', err.storedHash, err.incomingHash);
  } else if (err instanceof FluxoraApiError) {
    console.error(\`HTTP \${err.statusCode} [\${err.code}]: \${err.message}\`);
    // err.requestId — correlate with server logs
  } else if (err instanceof ValidationError) {
    console.error('Bad input:', err.message);
  }
}
\`\`\`

---

## Idempotency

POST /api/streams requires an \`Idempotency-Key\` header. The SDK handles this automatically:

- If you omit \`idempotencyKey\`, the SDK auto-generates a UUID v4.
- The SDK does **not** retry requests internally. If your application retries, supply and reuse the **same key** for every attempt of the same logical create operation.
- Reusing a key with a **different body** throws \`IdempotencyConflictError\`.

\`\`\`typescript
const key = generateIdempotencyKey(); // UUID v4
const stream = await client.createStream(payload, key);
// On retry:
const same = await client.createStream(payload, key); // replays cached response
\`\`\`

---

## Security notes

- Bearer tokens and API keys are stored in memory only and never logged.
- The \`Authorization\` and \`X-API-Key\` headers are only added when non-empty credentials are present; runtime setters trim surrounding whitespace.
- Client-side input validation rejects obviously invalid values before network dispatch.
- Per-request SDK headers override constructor headers. Runtime credentials override any user-supplied \`Authorization\` or \`X-API-Key\` constructor headers.
- TLS certificate validation is performed by the platform's \`fetch\` implementation.
- Idempotency key values are never echoed in error bodies or logs (server-side guarantee).

---

## SDK Generation Contract

The TypeScript SDK is generated from \`openapi.yaml\` and its compatibility
surface is intentionally small:

- Public exports remain \`types\`, \`errors\`, \`idempotency\`, \`pagination\`, and \`client\`.
- \`FluxoraClient\` methods preserve the current backend envelopes and unwrap only the documented stream convenience shapes.
- Requests use native \`fetch\` once per SDK method call. Network failures from \`fetch\` are allowed to bubble unchanged.
- Query parameters omit only \`undefined\` and \`null\` values; \`false\`, \`0\`, and empty strings are serialized.
- JSON responses are parsed when possible. Empty successful responses resolve to \`{}\`; text error bodies become \`FluxoraApiError\` messages.
- Request IDs are read from \`X-Request-ID\` first, then response envelope metadata, then nested error objects.
- Generated output must pass \`pnpm check:sdk:ts\`; drift is treated as a regression.

---

## API Reference

### \`new FluxoraClient(config?)\`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| \`baseUrl\` | \`string\` | \`'http://localhost:3000'\` | API base URL |
| \`bearerToken\` | \`string\` | — | JWT from \`createSession()\` |
| \`apiKey\` | \`string\` | — | Static API key (\`X-API-Key\` header) |
| \`headers\` | \`Record<string, string>\` | — | Extra headers merged into every request |

### Stream methods

| Method | Description |
|--------|-------------|
| \`createStream(input, key?)\` | POST /api/streams — auto-generates key if omitted |
| \`getStream(id)\` | GET /api/streams/:id |
| \`listStreams(params?)\` | Returns a \`StreamPaginator\` |
| \`cancelStream(id)\` | DELETE /api/streams/:id |
| \`updateStreamStatus(id, status)\` | PATCH /api/streams/:id/status |

### Other methods

| Method | Description |
|--------|-------------|
| \`getRoot()\` | GET / |
| \`getHealth()\` | GET /health |
| \`getHealthReady()\` | GET /health/ready |
| \`getHealthLive()\` | GET /health/live |
| \`createSession(address, role?)\` | POST /api/auth/session |
| \`getPrivacyPolicy()\` | GET /api/privacy/policy |
| \`getPrivacyRetention()\` | GET /api/privacy/retention |
| \`putPrivacyConsent(consent)\` | PUT /api/privacy/consent |
| \`getPrivacyConsent(address)\` | GET /api/privacy/consent/:address |
| \`queueWebhook(payload)\` | POST /internal/webhooks/queue |
| \`getWebhookDelivery(id)\` | GET /internal/webhooks/:id |

---

## Pagination

\`listStreams()\` returns a \`StreamPaginator\`. Use \`autoPaginate()\` or \`nextPage()\`:

\`\`\`typescript
// Async generator — iterate all streams
for await (const stream of client.listStreams().autoPaginate()) {
  process(stream);
}

// Manual paging
const pager = client.listStreams({ limit: 50, status: 'active' });
let page = await pager.nextPage();
while (page) {
  doSomething(page);
  page = await pager.nextPage();
}
\`\`\`

Cursors are **opaque base64url tokens** — never construct or decode them.
See [\`docs/openapi/README.md\`](../../docs/openapi/README.md) for full cursor semantics.

---

## Regenerating the SDK

\`\`\`bash
pnpm generate:sdk:ts        # regenerate sdk/typescript/
pnpm check:sdk:ts           # CI drift check — exits 1 if files differ
\`\`\`

The generator reads \`openapi.yaml\` and overwrites all files under \`sdk/typescript/\`.
`;
}

// ── src/index.ts ──────────────────────────────────────────────────────────────

function generateIndex() {
  return `/**
 * @fluxora/sdk — TypeScript Client SDK
 *
 * Generated from \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
 * Do not edit by hand — run \`pnpm generate:sdk:ts\` instead.
 *
 * @module @fluxora/sdk
 */
export * from './types.js';
export * from './errors.js';
export * from './idempotency.js';
export * from './pagination.js';
export * from './client.js';
`;
}

// ── src/types.ts ──────────────────────────────────────────────────────────────

function generateTypes() {
  return `/**
 * Typed request/response interfaces for the Fluxora Backend API.
 *
 * Generated from \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
 * Do not edit by hand — run \`pnpm generate:sdk:ts\` instead.
 *
 * ## Decimal-string invariant
 * All monetary fields (\`depositAmount\`, \`streamedAmount\`, \`remainingAmount\`,
 * \`ratePerSecond\`) are **decimal strings** — never JavaScript numbers.
 * This preserves precision across the Stellar/API boundary.
 *
 * ## Field naming
 * All field names are camelCase, exactly as returned by \`toApiStream()\` in
 * \`src/routes/streams.ts\`.
 *
 * @module @fluxora/sdk/types
 */

// ── Shared ────────────────────────────────────────────────────────────────────

/**
 * Data classification levels for PII policy.
 * Mirrors the server-side \`DataClassification\` enum.
 */
export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';

/**
 * Common response envelope metadata present on all API responses.
 */
export interface ResponseMeta {
  /** ISO-8601 UTC timestamp of when the response was generated. */
  timestamp?: string;
  /** Correlation ID — matches \`X-Request-ID\` header. */
  requestId?: string;
  /** Opaque cursor for the next page (list endpoints only). */
  next_cursor?: string;
  /** Total count — present only when \`include_total=true\` was requested. */
  total?: number;
  /** \`true\` when the response was served from the idempotency cache. */
  idempotency_replayed?: boolean;
  /** Alias used on some success envelopes. */
  idempotencyReplayed?: boolean;
}

// ── Stream ────────────────────────────────────────────────────────────────────

/**
 * Stream lifecycle status.
 *
 * Valid transitions (enforced by the server state machine):
 *   active    → paused | completed | cancelled
 *   paused    → active | cancelled
 *   completed → (terminal)
 *   cancelled → (terminal)
 */
export type StreamStatus = 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * A Fluxora treasury stream record as returned by GET /api/streams and
 * POST /api/streams.
 *
 * Field names match \`toApiStream()\` in \`src/routes/streams.ts\` exactly.
 * Amount fields are always decimal strings.
 */
export interface Stream {
  /** Unique stream ID (format: \`stream-{64-char-hex}-0\`). */
  id: string;
  /** Sender Stellar public key (\`G\` + 55 base32 chars). Pattern: \`^G[A-Z2-7]{55}$\` */
  sender: string;
  /** Recipient Stellar public key. Pattern: \`^G[A-Z2-7]{55}$\` */
  recipient: string;
  /** Total deposit as a decimal string (e.g. \`"1000000.0000000"\`). */
  depositAmount: string;
  /** Amount streamed so far as a decimal string. */
  streamedAmount: string;
  /** Remaining un-streamed balance as a decimal string. */
  remainingAmount: string;
  /** Streaming rate per second as a decimal string. */
  ratePerSecond: string;
  /** Stream start time (Unix epoch seconds). */
  startTime: number;
  /** Stream end time (0 = indefinite). */
  endTime: number;
  /** Current lifecycle status. */
  status: StreamStatus;
  /** Soroban contract address managing this stream (optional). */
  contractId?: string;
  /** Transaction hash of the creation transaction (optional). */
  transactionHash?: string;
  /** Event position within the originating transaction (optional). */
  eventIndex?: number;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt?: string;
}

/**
 * Request body for POST /api/streams.
 * Amount fields must be decimal strings.
 */
export interface CreateStreamInput {
  /** Sender Stellar public key. Pattern: \`^G[A-Z2-7]{55}$\` */
  sender: string;
  /** Recipient Stellar public key. Pattern: \`^G[A-Z2-7]{55}$\` */
  recipient: string;
  /**
   * Total deposit as a decimal string.
   * Must be > 0 and ≥ \`ratePerSecond\`.
   */
  depositAmount: string;
  /**
   * Streaming rate per second as a positive decimal string.
   */
  ratePerSecond: string;
  /** Optional Unix epoch start time. Defaults to now. */
  startTime?: number;
  /** Optional Unix epoch end time (0 = indefinite). */
  endTime?: number;
}

// ── API Response Envelopes ────────────────────────────────────────────────────

/**
 * Paginated list response from GET /api/streams.
 *
 * The \`data\` property carries the paginated list shape.
 * Pagination state (\`has_more\`, \`next_cursor\`) lives inside \`data\`.
 */
export interface StreamListResponse {
  success: boolean;
  data: {
    /** Streams on this page, ordered by \`id\` ASC. */
    streams: Stream[];
    /** \`true\` when additional pages exist. */
    has_more: boolean;
    /** Opaque cursor for the next request; \`null\` on the last page. */
    next_cursor: string | null;
    /** Total count — only present when \`include_total=true\` was requested. */
    total?: number;
  };
  meta: ResponseMeta;
}

/**
 * Single-stream response from GET /api/streams/:id.
 * The stream is nested as \`data.stream\`.
 */
export interface StreamSingleResponse {
  success: boolean;
  data: { stream: Stream };
  meta?: ResponseMeta;
}

/**
 * Stream creation response from POST /api/streams.
 * The created stream is returned directly in \`data\`.
 */
export interface StreamCreateResponse {
  success: boolean;
  data: Stream;
  meta?: ResponseMeta;
}

// ── Health ────────────────────────────────────────────────────────────────────

/**
 * Response shape for GET /health, /health/ready, and /health/live.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'shutting_down' | 'healthy' | 'unhealthy';
  service?: string;
  network?: string;
  timestamp?: string;
  version?: string;
  uptimeSeconds?: number;
  checks?: Record<string, unknown>;
  indexer?: Record<string, unknown>;
}

// ── Root ──────────────────────────────────────────────────────────────────────

/** Response from GET /. */
export interface RootResponse {
  name: string;
  version: string;
  description?: string;
  docs?: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** Response from POST /api/auth/session. */
export interface AuthSessionResponse {
  success: boolean;
  data: {
    token: string;
    user?: { address: string; role: string };
    address?: string;
    role?: string;
    expiresAt?: string;
  };
  meta?: ResponseMeta;
}

// ── Privacy ───────────────────────────────────────────────────────────────────

/** A user's privacy consent record. */
export interface PrivacyConsent {
  analytics_optout: boolean;
  marketing_optout: boolean;
  biometric_processing_consent: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Response from PUT/GET /api/privacy/consent. */
export interface PrivacyConsentResponse {
  success: boolean;
  data: { consent: PrivacyConsent };
  meta?: ResponseMeta;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

/** A webhook delivery record. */
export interface WebhookDelivery {
  id: string;
  delivery_id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'success' | 'failed';
  created_at: string;
  updated_at: string;
  attempts?: Array<Record<string, unknown>>;
}

// ── Pagination parameters ─────────────────────────────────────────────────────

/**
 * Query parameters for GET /api/streams.
 * \`limit\` must be 1–100. \`cursor\` must be an opaque token from \`next_cursor\`.
 */
export interface ListStreamsParams {
  /** Page size (1–100). Defaults to 20 on the server. */
  limit?: number;
  /** Opaque pagination cursor from a previous \`next_cursor\`. Omit for the first page. */
  cursor?: string;
  /** Filter by stream status. */
  status?: string;
  /** Filter by sender Stellar address. */
  sender?: string;
  /** Filter by recipient Stellar address. */
  recipient?: string;
  /** When \`true\`, include \`total\` count in the response. */
  include_total?: boolean;
}
`;
}

// ── src/errors.ts ─────────────────────────────────────────────────────────────

function generateErrors() {
  return `/**
 * Typed SDK exception hierarchy.
 *
 * Generated from \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
 * Do not edit by hand — run \`pnpm generate:sdk:ts\` instead.
 *
 * ## Hierarchy
 * \`\`\`
 * Error
 * └─ FluxoraClientError            (base for all SDK errors)
 *    ├─ FluxoraApiError             (non-2xx HTTP response)
 *    │  └─ IdempotencyConflictError (409 IDEMPOTENCY_CONFLICT)
 *    └─ ValidationError             (client-side input validation failure)
 * \`\`\`
 *
 * All classes call \`Object.setPrototypeOf(this, new.target.prototype)\` to
 * ensure correct \`instanceof\` behaviour after TypeScript transpilation.
 *
 * @module @fluxora/sdk/errors
 */

// ── Base ──────────────────────────────────────────────────────────────────────

/**
 * Base class for all errors thrown by the Fluxora TypeScript SDK.
 * Catch this type to handle both API errors and client-side validation failures.
 */
export class FluxoraClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FluxoraClientError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── API Error ─────────────────────────────────────────────────────────────────

/**
 * Thrown when the Fluxora API returns a non-2xx HTTP response.
 *
 * @example
 * \`\`\`typescript
 * try {
 *   await client.getStream('missing-id');
 * } catch (err) {
 *   if (err instanceof FluxoraApiError) {
 *     console.error(\`HTTP \${err.statusCode} [\${err.code}]: \${err.message}\`);
 *     if (err.requestId) console.error('Request ID:', err.requestId);
 *   }
 * }
 * \`\`\`
 */
export class FluxoraApiError extends FluxoraClientError {
  /** HTTP status code (e.g. \`400\`, \`404\`, \`503\`). */
  public readonly statusCode: number;
  /** Machine-readable error code (e.g. \`'VALIDATION_ERROR'\`, \`'NOT_FOUND'\`). */
  public readonly code: string;
  /** Additional error context from the server response. */
  public readonly details?: unknown;
  /**
   * Correlation ID (\`X-Request-ID\` header) for tracing.
   * Include in support tickets to correlate with server logs.
   */
  public readonly requestId?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(\`[\${statusCode}] \${code}: \${message}\`);
    this.name = 'FluxoraApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Idempotency Conflict ──────────────────────────────────────────────────────

/**
 * Thrown when the server returns HTTP 409 with code \`IDEMPOTENCY_CONFLICT\`.
 * The same \`Idempotency-Key\` was previously used with a **different** body.
 *
 * ## Resolution
 * - Generate a fresh idempotency key for the new request, **or**
 * - Retry with the original request body and the same key.
 *
 * @example
 * \`\`\`typescript
 * try {
 *   await client.createStream(payload, 'my-key');
 * } catch (err) {
 *   if (err instanceof IdempotencyConflictError) {
 *     console.error('Payload mismatch!');
 *     console.error('Stored hash:   ', err.storedHash);
 *     console.error('Incoming hash: ', err.incomingHash);
 *   }
 * }
 * \`\`\`
 */
export class IdempotencyConflictError extends FluxoraApiError {
  /** SHA-256 fingerprint of the **original** request body stored for this key. */
  public readonly storedHash?: string;
  /** SHA-256 fingerprint of the **current** (conflicting) request body. */
  public readonly incomingHash?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    storedHash?: string,
    incomingHash?: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(statusCode, code, message, details, requestId);
    this.name = 'IdempotencyConflictError';
    this.storedHash = storedHash;
    this.incomingHash = incomingHash;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Validation Error ──────────────────────────────────────────────────────────

/**
 * Thrown when **client-side** input validation rejects a parameter before any
 * HTTP request is dispatched.
 *
 * This is distinct from \`FluxoraApiError\` with \`code = 'VALIDATION_ERROR'\`,
 * which indicates a server-side rejection.
 *
 * @example
 * \`\`\`typescript
 * try {
 *   await client.getStream('');
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     console.error('Bad input:', err.message);
 *   }
 * }
 * \`\`\`
 */
export class ValidationError extends FluxoraClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
`;
}

// ── src/idempotency.ts ────────────────────────────────────────────────────────

function generateIdempotency() {
  return `/**
 * Idempotency key generation and payload hashing utilities.
 *
 * Generated from \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
 * Do not edit by hand — run \`pnpm generate:sdk:ts\` instead.
 *
 * ## Purpose
 * POST /api/streams requires an \`Idempotency-Key\` header to prevent duplicate
 * stream creation on retries. This module provides:
 *
 * - \`generateIdempotencyKey()\` — creates a fresh UUID v4 key per operation.
 * - \`canonicalizeBody()\` — serialises an object to a deterministic JSON string
 *   (sorted keys, recursive) suitable for hashing.
 * - \`hashBody()\` — computes a SHA-256 hex digest matching the server-side
 *   \`fingerprintInput()\` in \`src/routes/streams.ts\`.
 *
 * ## Security
 * - Keys are generated with \`crypto.randomUUID()\` (WebCrypto) where available,
 *   with a \`Math.random\`-based UUID v4 fallback for older environments.
 * - \`hashBody()\` uses \`crypto.subtle.digest\` (WebCrypto) with a Node.js
 *   \`node:crypto\` \`createHash\` fallback.
 * - Key values are never logged or echoed in error responses.
 *
 * @module @fluxora/sdk/idempotency
 */

// ── Key Generation ────────────────────────────────────────────────────────────

/**
 * Generate a unique UUID v4 idempotency key.
 *
 * Uses \`crypto.randomUUID()\` (Node.js ≥ 15, all modern browsers).
 * Falls back to a \`Math.random\`-based v4 UUID for older environments.
 *
 * Generate a **new key per logical operation**. Reuse the same key when
 * retrying a failed request to make it idempotent.
 *
 * @returns A UUID v4 string (e.g. \`'b4a6f1a2-33c9-4d8e-b789-0e0a1c2d3e4f'\`).
 *
 * @example
 * \`\`\`typescript
 * const key = generateIdempotencyKey();
 * const stream = await client.createStream(input, key);
 * // Retry with same key — gets cached response
 * const same = await client.createStream(input, key);
 * \`\`\`
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Math.random fallback for environments without WebCrypto
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Canonical JSON ────────────────────────────────────────────────────────────

/**
 * Recursively serialise a value to a **canonical** JSON string.
 *
 * Canonical form guarantees that two logically equal objects always produce
 * the same string regardless of key insertion order, enabling deterministic
 * payload fingerprinting that matches the server-side \`fingerprintInput()\`.
 *
 * Rules:
 * - Object keys are sorted lexicographically (ascending, recursive).
 * - Array element order is preserved.
 * - Primitives are serialised as \`JSON.stringify\` would.
 * - \`null\` and \`undefined\` are both serialised as \`'null'\`.
 *
 * @param body - Any JSON-serialisable value.
 * @returns A deterministic JSON string.
 *
 * @example
 * \`\`\`typescript
 * canonicalizeBody({ z: 1, a: 2 }); // '{"a":2,"z":1}'
 * canonicalizeBody({ a: 2, z: 1 }); // '{"a":2,"z":1}'  — identical
 * \`\`\`
 */
export function canonicalizeBody(body: unknown): string {
  if (body === null || body === undefined) return 'null';
  if (typeof body !== 'object') return JSON.stringify(body);

  if (Array.isArray(body)) {
    const items = (body as unknown[]).map((item) => canonicalizeBody(item));
    return \`[\${items.join(',')}]\`;
  }

  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => \`"\${k}":\${canonicalizeBody(obj[k])}\`);
  return \`{\${pairs.join(',')}}\`;
}

// ── SHA-256 Hashing ───────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of a JSON payload.
 *
 * The payload is canonicalised via \`canonicalizeBody()\` and UTF-8 encoded
 * before hashing. The digest matches the server-side \`fingerprintInput()\`
 * in \`src/routes/streams.ts\`.
 *
 * Prefers \`crypto.subtle.digest\` (WebCrypto) with a Node.js
 * \`node:crypto\` \`createHash\` fallback.
 *
 * @param body - Any JSON-serialisable value.
 * @returns A lowercase 64-character SHA-256 hex string.
 * @throws {Error} When no crypto API is available.
 *
 * @example
 * \`\`\`typescript
 * const hash = await hashBody({ sender: 'G...', depositAmount: '100' });
 * console.log(hash.length); // 64
 * \`\`\`
 */
export async function hashBody(body: unknown): Promise<string> {
  const canonical = canonicalizeBody(body);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Node.js crypto fallback for environments without globalThis.crypto
  try {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    throw new Error('Crypto API unavailable: cannot compute SHA-256 hash');
  }
}

// ── Idempotency Helper ────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  response: T;
  statusCode: number;
}

export interface ICacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, entry: CacheEntry<T>, ttlSeconds?: number): Promise<void>;
  /** Returns false if the lock is already held */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}

export interface IdempotencyOptions {
  /** The unique idempotency key provided by the client */
  idempotencyKey: string;
  /** The identifier of the authenticated caller (e.g. user ID or API key ID) */
  callerId: string;
  /** TTL for the idempotency cache in seconds (default: 86400 / 24h) */
  ttlSeconds?: number;
}

export interface Logger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}

export class IdempotencyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export class IdempotencyHelper {
  constructor(
    private store: ICacheStore,
    private logger: Logger = console
  ) {}

  /**
   * Executes an operation idempotently.
   * 
   * @param options Idempotency settings including the key and caller context.
   * @param operation The business logic to execute if this is a fresh request.
   * @returns The result of the operation or the cached result.
   */
  async execute<T>(
    options: IdempotencyOptions,
    operation: () => Promise<{ response: T; statusCode: number }>
  ): Promise<{ response: T; statusCode: number; cached: boolean }> {
    const { idempotencyKey, callerId, ttlSeconds = 86400 } = options;

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      this.logger.warn('Idempotency validation failed: Invalid idempotency key', { idempotencyKey, callerId });
      throw new IdempotencyError('INVALID_KEY', 'Idempotency key is required and must be a valid string.');
    }

    if (!callerId || typeof callerId !== 'string' || callerId.trim() === '') {
      this.logger.warn('Idempotency validation failed: Invalid caller ID', { idempotencyKey, callerId });
      throw new IdempotencyError('INVALID_CALLER', 'Caller ID is required and must be a valid string.');
    }

    // Isolate keys per caller to prevent cross-tenant collisions
    const scopedKey = \`idempotency:\${callerId}:\${idempotencyKey}\`;

    // 1. Check if we already have a completed response
    const cached = await this.store.get<T>(scopedKey);
    if (cached) {
      this.logger.info('Idempotency cache hit', { idempotencyKey, callerId });
      return { ...cached, cached: true };
    }

    // 2. Acquire a lock to prevent concurrent processing of the same key
    const lockKey = \`\${scopedKey}:lock\`;
    const lockAcquired = await this.store.acquireLock(lockKey, 30); // 30 second lock
    if (!lockAcquired) {
      this.logger.warn('Concurrent request collision', { idempotencyKey, callerId });
      throw new IdempotencyError('CONCURRENT_REQUEST', 'A request with this idempotency key is already in progress.');
    }

    try {
      // 3. Execute the operation
      this.logger.info('Executing fresh operation', { idempotencyKey, callerId });
      const result = await operation();

      // 4. Cache the result for future replays
      await this.store.set(scopedKey, result, ttlSeconds);
      
      return { ...result, cached: false };
    } catch (error) {
      this.logger.error('Operation failed during idempotent execution', { idempotencyKey, callerId, error });
      throw error;
    } finally {
      // 5. Release the lock
      await this.store.releaseLock(lockKey);
    }
  }
}
`;
}

// ── src/pagination.ts ─────────────────────────────────────────────────────────

function generatePagination() {
  return `/**
 * Cursor-based paginator for GET /api/streams.
 *
 * Generated from \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
 * Do not edit by hand — run \`pnpm generate:sdk:ts\` instead.
 *
 * ## Design
 * \`StreamPaginator\` wraps the server's keyset-cursor pagination behind an
 * ergonomic API that never requires the caller to manage raw cursor tokens.
 *
 * - Call \`nextPage()\` to fetch one page at a time.
 * - Use \`autoPaginate()\` (async generator) to iterate all streams across all
 *   pages with a \`for await...of\` loop.
 * - Pagination terminates when the server returns \`has_more: false\`.
 *
 * ## Cursor semantics
 * Cursors are **opaque base64url tokens** issued by the server. Clients must
 * treat them as black boxes — do not construct or decode manually.
 * See \`docs/openapi/README.md\` for the full cursor protocol.
 *
 * @module @fluxora/sdk/pagination
 */

import type { Stream, ListStreamsParams, StreamListResponse } from './types.js';

/**
 * Cursor-based paginator for the GET /api/streams endpoint.
 *
 * @example
 * \`\`\`typescript
 * const paginator = client.listStreams({ limit: 20, status: 'active' });
 *
 * // Option A — iterate individual stream items
 * for await (const stream of paginator.autoPaginate()) {
 *   console.log(stream.id, stream.depositAmount);
 * }
 *
 * // Option B — fetch one page at a time
 * const page1 = await paginator.nextPage();
 * const page2 = await paginator.nextPage();
 * \`\`\`
 */
export class StreamPaginator {
  private readonly fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>;
  private readonly limit: number;
  private readonly status?: string;
  private readonly sender?: string;
  private readonly recipient?: string;
  private readonly includeTotal: boolean;

  /** Opaque cursor from the last response; \`null\` = start of sequence. */
  private nextCursor: string | null = null;
  /** \`false\` once the server signals no more pages. */
  private hasMore = true;

  /**
   * @param fetchPage - Calls the API and returns a \`StreamListResponse\`.
   * @param params    - Initial filter and pagination parameters.
   * @throws {Error} When \`limit\` is outside the valid range 1–100.
   */
  constructor(
    fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>,
    params: ListStreamsParams = {},
  ) {
    const limit = params.limit ?? 20;
    if (limit < 1 || limit > 100) {
      throw new Error('limit must be an integer between 1 and 100 per paginationSchema');
    }
    this.fetchPage = fetchPage;
    this.limit = limit;
    this.status = params.status;
    this.sender = params.sender;
    this.recipient = params.recipient;
    this.includeTotal = params.include_total ?? false;
  }

  /**
   * Fetch the next page of stream results.
   *
   * @returns Array of \`Stream\` objects for this page, or \`null\` when all
   *          pages have been consumed (\`has_more\` was \`false\`).
   */
  async nextPage(): Promise<Stream[] | null> {
    if (!this.hasMore) return null;

    const response = await this.fetchPage({
      limit: this.limit,
      cursor: this.nextCursor ?? undefined,
      status: this.status,
      sender: this.sender,
      recipient: this.recipient,
      include_total: this.includeTotal,
    });

    const pageData = response.data;
    const streams: Stream[] = pageData?.streams ?? [];
    const hasMore: boolean = pageData?.has_more ?? false;
    const nextCursor: string | null =
      pageData?.next_cursor ??
      (response.meta?.next_cursor as string | null | undefined) ??
      null;

    if (nextCursor && hasMore) {
      this.nextCursor = nextCursor;
    } else {
      this.hasMore = false;
    }

    return streams;
  }

  /**
   * Async generator that yields individual \`Stream\` items across all pages.
   *
   * Pagination terminates automatically when the server has no more results.
   * A \`break\` inside \`for await\` stops iteration without fetching further pages.
   *
   * @yields \`Stream\` objects one at a time.
   */
  async *autoPaginate(): AsyncGenerator<Stream, void, unknown> {
    while (this.hasMore) {
      const page = await this.nextPage();
      if (!page) break;
      for (const item of page) {
        yield item;
      }
    }
  }
}
`;
}

// ── src/client.ts ─────────────────────────────────────────────────────────────

function generateClient() {
  return `/**
 * FluxoraClient — typed HTTP client for the Fluxora Backend API.
 *
 * Generated from \`openapi.yaml\` by \`scripts/generate-sdk-ts.mjs\`.
 * Do not edit by hand — run \`pnpm generate:sdk:ts\` instead.
 *
 * ## Design
 * - Zero external runtime dependencies — uses the standard Web \`fetch\` API.
 * - All monetary amounts flow as **decimal strings** (never JS numbers).
 * - Idempotency keys are auto-generated for POST /api/streams when omitted.
 * - Cursor-based pagination is encapsulated in \`StreamPaginator\`.
 * - The SDK performs no hidden retries; callers own retry policy and should
 *   reuse explicit idempotency keys for retried stream creation attempts.
 *
 * ## Security notes
 * - Bearer tokens and API keys are stored in memory only; never logged.
 * - Auth headers are only set when non-empty credentials are present.
 * - Client-side validation (empty/missing required params) fires before any
 *   network round-trip, reducing the attack surface for injection.
 * - TLS validation is delegated to the platform's \`fetch\` implementation.
 * - Idempotency key values are never echoed in error bodies (server guarantee).
 *
 * @module @fluxora/sdk/client
 */

import { FluxoraApiError, IdempotencyConflictError, ValidationError } from './errors.js';
import { generateIdempotencyKey } from './idempotency.js';
import { StreamPaginator } from './pagination.js';
import type {
  Stream,
  CreateStreamInput,
  StreamListResponse,
  StreamSingleResponse,
  StreamCreateResponse,
  HealthResponse,
  RootResponse,
  AuthSessionResponse,
  PrivacyConsent,
  PrivacyConsentResponse,
  WebhookDelivery,
  ListStreamsParams,
} from './types.js';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Client initialisation options.
 *
 * @example
 * \`\`\`typescript
 * const client = new FluxoraClient({
 *   baseUrl: 'https://api.fluxora.example.com',
 *   bearerToken: process.env.FLUXORA_TOKEN,
 * });
 * \`\`\`
 */
export interface FluxoraClientConfig {
  /**
   * Base URL of the Fluxora API. Trailing slashes are stripped automatically.
   * Defaults to \`'http://localhost:3000'\`.
   */
  baseUrl?: string;
  /**
   * Static API key sent as \`X-API-Key\`.
   * Can be updated at runtime via \`setApiKey()\`.
   */
  apiKey?: string;
  /**
   * JWT Bearer token.
   * Can be updated at runtime via \`setBearerToken()\`.
   */
  bearerToken?: string;
  /**
   * Additional headers merged into every request.
   * Per-request headers take precedence over these.
   */
  headers?: Record<string, string>;
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Typed HTTP client for the Fluxora Backend API.
 *
 * All methods return strongly-typed response objects matching the shapes
 * defined in \`openapi.yaml\` and mirroring \`src/routes/streams.ts\`.
 */
export class FluxoraClient {
  private baseUrl: string;
  private apiKey?: string;
  private bearerToken?: string;
  private headers: Record<string, string>;

  constructor(config: FluxoraClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:3000').replace(/\\/+$/, '');
    this.apiKey = config.apiKey?.trim() || undefined;
    this.bearerToken = config.bearerToken?.trim() || undefined;
    this.headers = {
      'User-Agent': 'FluxoraTypeScriptSDK/0.1.0',
      Accept: 'application/json',
      ...config.headers,
    };
  }

  /**
   * Update the JWT Bearer token for authenticated requests.
   * The new value is used immediately on the next call.
   * @security Token is stored in memory only; never logged.
   */
  public setBearerToken(token: string): void {
    this.bearerToken = token.trim() || undefined;
  }

  /**
   * Update the static API key (\`X-API-Key\` header).
   * @security Key is stored in memory only; never logged.
   */
  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey.trim() || undefined;
  }

  // ── Core HTTP dispatcher ───────────────────────────────────────────────────

  /**
   * Execute an HTTP request and return the parsed JSON response body.
   *
   * On non-2xx responses the method throws:
   * - \`IdempotencyConflictError\` for 409 \`IDEMPOTENCY_CONFLICT\`
   * - \`FluxoraApiError\` for all other non-2xx responses
   *
   * The dispatcher intentionally performs exactly one \`fetch\` call. Retry,
   * timeout, and abort policies belong to the caller or runtime \`fetch\`
   * implementation so SDK behavior remains deterministic across deploys.
   *
   * @param method  - HTTP verb (GET, POST, DELETE, PATCH, PUT).
   * @param path    - Request path (e.g. \`'/api/streams'\`).
   * @param options - Optional query params, body, and extra headers.
   */
  private async request<T>(
    method: string,
    path: string,
    options: {
      params?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    let url = \`\${this.baseUrl}\${path}\`;

    if (options.params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += \`?\${s}\`;
    }

    const headers: Record<string, string> = { ...this.headers, ...options.headers };
    if (this.bearerToken) headers['Authorization'] = \`Bearer \${this.bearerToken}\`;
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    let bodyPayload: string | undefined;
    if (options.body !== undefined) {
      bodyPayload = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: bodyPayload,
    });

    let data: unknown = {};
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }

    if (!response.ok) {
      const d = data as Record<string, unknown>;
      const errObj = d['error'] as Record<string, unknown> | undefined;
      const requestId =
        response.headers.get('x-request-id') ??
        ((d['meta'] as Record<string, unknown>)?.['requestId'] as string | undefined) ??
        (errObj?.['requestId'] as string | undefined);
      const errorCode = (errObj?.['code'] ?? d['code'] ?? 'HTTP_ERROR') as string;
      const errorMessage = (errObj?.['message'] ?? d['message'] ?? response.statusText) as string;

      if (response.status === 409 && errorCode === 'IDEMPOTENCY_CONFLICT') {
        throw new IdempotencyConflictError(
          response.status,
          'IDEMPOTENCY_CONFLICT',
          errorMessage,
          (d['stored_hash'] ?? (d['details'] as Record<string, unknown>)?.['stored_hash']) as string | undefined,
          (d['incoming_hash'] ?? (d['details'] as Record<string, unknown>)?.['incoming_hash']) as string | undefined,
          d,
          requestId,
        );
      }

      throw new FluxoraApiError(
        response.status,
        errorCode,
        errorMessage,
        errObj?.['details'] ?? (d as Record<string, unknown>)['details'],
        requestId,
      );
    }

    return data as T;
  }

  // ── System Endpoints ───────────────────────────────────────────────────────

  /** GET / — API root metadata. */
  async getRoot(): Promise<RootResponse> {
    const res = await this.request<{ success?: boolean; data?: RootResponse } & RootResponse>('GET', '/');
    return (res.data ?? res) as RootResponse;
  }

  /** GET /health — Liveness probe. Returns 503 during graceful shutdown. */
  async getHealth(): Promise<HealthResponse> {
    const res = await this.request<{ success?: boolean; data?: HealthResponse } & HealthResponse>('GET', '/health');
    return (res.data ?? res) as HealthResponse;
  }

  /** GET /health/ready — Readiness probe. Returns 503 if any dependency is unhealthy. */
  async getHealthReady(): Promise<HealthResponse> {
    const res = await this.request<{ success?: boolean; data?: HealthResponse } & HealthResponse>('GET', '/health/ready');
    return (res.data ?? res) as HealthResponse;
  }

  /** GET /health/live — Detailed liveness report. */
  async getHealthLive(): Promise<HealthResponse> {
    const res = await this.request<{ success?: boolean; data?: HealthResponse } & HealthResponse>('GET', '/health/live');
    return (res.data ?? res) as HealthResponse;
  }

  // ── Auth Endpoints ─────────────────────────────────────────────────────────

  /**
   * POST /api/auth/session — Create an authenticated session.
   *
   * Issues a signed JWT for use as a Bearer token on subsequent requests.
   *
   * @param address - Stellar public key (56-char G…).
   * @param role    - User role (defaults to \`'viewer'\`).
   * @throws {ValidationError} When \`address\` is empty.
   * @throws {FluxoraApiError} On 400 (invalid address format).
   */
  async createSession(address: string, role = 'viewer'): Promise<AuthSessionResponse> {
    if (!address) throw new ValidationError('address is required for createSession');
    return this.request<AuthSessionResponse>('POST', '/api/auth/session', {
      body: { address, role },
    });
  }

  // ── Stream Endpoints ───────────────────────────────────────────────────────

  /**
   * POST /api/streams — Create a new treasury stream.
   *
   * Automatically generates an idempotency key when \`idempotencyKey\` is
   * omitted. Supply your own key when retrying a failed request to prevent
   * duplicate creation.
   *
   * @param input          - Stream creation parameters.
   * @param idempotencyKey - Optional client-supplied idempotency key (UUID v4 recommended).
   * @returns Created stream record.
   *
   * @throws {ValidationError}          When required fields are missing.
   * @throws {IdempotencyConflictError} On 409 key + body mismatch.
   * @throws {FluxoraApiError}          On other API errors.
   *
   * @example
   * \`\`\`typescript
   * const stream = await client.createStream({
   *   sender:        'GAAZI4...',
   *   recipient:     'GBBD47...',
   *   depositAmount: '1000000.0000000',
   *   ratePerSecond: '0.0000116',
   *   startTime:     Math.floor(Date.now() / 1000),
   * });
   * \`\`\`
   */
  async createStream(input: CreateStreamInput, idempotencyKey?: string): Promise<Stream> {
    if (!input?.sender || !input.recipient || !input.depositAmount || !input.ratePerSecond) {
      throw new ValidationError(
        'CreateStreamInput must include sender, recipient, depositAmount, and ratePerSecond',
      );
    }
    const key = idempotencyKey ?? generateIdempotencyKey();
    const res = await this.request<StreamCreateResponse>('POST', '/api/streams', {
      body: input,
      headers: { 'Idempotency-Key': key },
    });
    return res.data;
  }

  /**
   * GET /api/streams/:id — Fetch a single stream by ID.
   *
   * @param streamId - The stream identifier.
   * @throws {ValidationError} When \`streamId\` is empty.
   * @throws {FluxoraApiError} On 404 (not found) or 503.
   */
  async getStream(streamId: string): Promise<Stream> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<StreamSingleResponse>('GET', \`/api/streams/\${streamId}\`);
    return res.data.stream;
  }

  /**
   * GET /api/streams — List streams with cursor-based pagination.
   *
   * Returns a \`StreamPaginator\` which lazily fetches pages on demand.
   *
   * @param params - Optional filter and pagination parameters.
   * @returns A \`StreamPaginator\` instance.
   *
   * @example
   * \`\`\`typescript
   * for await (const stream of client.listStreams({ status: 'active' }).autoPaginate()) {
   *   console.log(stream.id, stream.depositAmount);
   * }
   * \`\`\`
   */
  listStreams(params: ListStreamsParams = {}): StreamPaginator {
    return new StreamPaginator(
      (p) => this.request<StreamListResponse>('GET', '/api/streams', {
        params: p as Record<string, unknown>,
      }),
      params,
    );
  }

  /**
   * DELETE /api/streams/:id — Cancel an active stream.
   *
   * @param streamId - The stream identifier.
   * @throws {ValidationError} When \`streamId\` is empty.
   * @throws {FluxoraApiError} On 404, 409 (already completed/cancelled), or 503.
   */
  async cancelStream(streamId: string): Promise<{ message: string; id: string }> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<{ success: boolean; data: { message: string; id: string } }>(
      'DELETE',
      \`/api/streams/\${streamId}\`,
    );
    return res.data;
  }

  /**
   * PATCH /api/streams/:id/status — Transition a stream to a new lifecycle status.
   *
   * @param streamId  - The stream identifier.
   * @param newStatus - Target status (\`active\`, \`paused\`, \`completed\`, or \`cancelled\`).
   * @returns Updated stream record.
   *
   * @throws {ValidationError} When \`streamId\` is empty.
   * @throws {FluxoraApiError} On 409 (invalid transition) or 404.
   */
  async updateStreamStatus(
    streamId: string,
    newStatus: 'active' | 'paused' | 'completed' | 'cancelled',
  ): Promise<Stream> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<StreamCreateResponse>(
      'PATCH',
      \`/api/streams/\${streamId}/status\`,
      { body: { status: newStatus } },
    );
    return res.data;
  }

  // ── Privacy Endpoints ──────────────────────────────────────────────────────

  /** GET /api/privacy/policy — Retrieve the PII policy document. */
  async getPrivacyPolicy(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/privacy/policy');
  }

  /** GET /api/privacy/retention — Retrieve the data retention schedule. */
  async getPrivacyRetention(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/privacy/retention');
  }

  /**
   * PUT /api/privacy/consent — Record or update a user's privacy consent.
   * @param consent - Consent record; \`address\` identifies the user.
   */
  async putPrivacyConsent(consent: {
    address: string;
    analytics_optout: boolean;
    marketing_optout: boolean;
    biometric_processing_consent: boolean;
  }): Promise<PrivacyConsent> {
    const res = await this.request<PrivacyConsentResponse>('PUT', '/api/privacy/consent', {
      body: consent,
    });
    return res.data.consent;
  }

  /**
   * GET /api/privacy/consent/:address — Fetch a user's current consent record.
   * @throws {ValidationError} When \`address\` is empty.
   */
  async getPrivacyConsent(address: string): Promise<PrivacyConsent> {
    if (!address) throw new ValidationError('address is required');
    const res = await this.request<PrivacyConsentResponse>('GET', \`/api/privacy/consent/\${address}\`);
    return res.data.consent;
  }

  // ── Webhook Endpoints ──────────────────────────────────────────────────────

  /** POST /internal/webhooks/queue — Queue a webhook delivery. */
  async queueWebhook(payload: Record<string, unknown>): Promise<WebhookDelivery> {
    const res = await this.request<{ success: boolean; data: WebhookDelivery }>(
      'POST',
      '/internal/webhooks/queue',
      { body: payload },
    );
    return res.data;
  }

  /** GET /internal/webhooks/:id — Retrieve a webhook delivery record. */
  async getWebhookDelivery(id: string): Promise<WebhookDelivery> {
    const res = await this.request<{ success: boolean; data: WebhookDelivery }>(
      'GET',
      \`/internal/webhooks/\${id}\`,
    );
    return res.data;
  }
}
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Entry point — load spec, generate files, write or diff.
 */
function main() {
  const spec = loadSpec(SPEC_PATH);
  const generatedFiles = generateTypeScriptSdk(spec);

  if (isCheckMode) {
    console.log(`[DRIFT CHECK] Checking TypeScript SDK files in ${OUT_DIR}...`);
    let hasDrift = false;

    for (const [relativePath, expectedContent] of Object.entries(generatedFiles)) {
      const fullPath = path.resolve(OUT_DIR, relativePath);

      if (!fs.existsSync(fullPath)) {
        console.error(`[DRIFT DETECTED] Missing file: ${relativePath}`);
        hasDrift = true;
        continue;
      }

      const existingContent = fs.readFileSync(fullPath, 'utf8');
      // Normalise line endings for cross-platform comparison
      if (existingContent.replace(/\r\n/g, '\n').trim() !== expectedContent.replace(/\r\n/g, '\n').trim()) {
        console.error(`[DRIFT DETECTED] Content mismatch: ${relativePath}`);
        hasDrift = true;
      }
    }

    if (hasDrift) {
      console.error('[DRIFT CHECK FAILED] Run `pnpm generate:sdk:ts` and commit the result.');
      process.exit(1);
    } else {
      console.log('[DRIFT CHECK PASSED] All TypeScript SDK files match generated output.');
      process.exit(0);
    }
  } else {
    console.log(`Generating TypeScript Client SDK into ${OUT_DIR}...`);
    fs.mkdirSync(path.resolve(OUT_DIR, 'src'), { recursive: true });

    for (const [relativePath, content] of Object.entries(generatedFiles)) {
      const fullPath = path.resolve(OUT_DIR, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      console.log(`  Wrote ${relativePath}`);
    }

    console.log('[SDK GENERATION COMPLETE] TypeScript Client SDK generated successfully.');
  }
}

main();
