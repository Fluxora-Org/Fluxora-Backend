/**
 * Typed request/response interfaces for the Fluxora Backend API.
 *
 * Generated from `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
 * Do not edit by hand — run `pnpm generate:sdk:ts` instead.
 *
 * ## Decimal-string invariant
 * All monetary fields (`depositAmount`, `streamedAmount`, `remainingAmount`,
 * `ratePerSecond`) are **decimal strings** — never JavaScript numbers.
 * This preserves precision across the Stellar/API boundary.
 *
 * ## Field naming
 * All field names are camelCase, exactly as returned by `toApiStream()` in
 * `src/routes/streams.ts`.
 *
 * @module @fluxora/sdk/types
 */

// ── Shared ────────────────────────────────────────────────────────────────────

/**
 * Data classification levels for PII policy.
 * Mirrors the server-side `DataClassification` enum.
 */
export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';

/**
 * Common response envelope metadata present on all API responses.
 */
export interface ResponseMeta {
  /** ISO-8601 UTC timestamp of when the response was generated. */
  timestamp?: string;
  /** Correlation ID — matches `X-Request-ID` header. */
  requestId?: string;
  /** Opaque cursor for the next page (list endpoints only). */
  next_cursor?: string;
  /** Total count — present only when `include_total=true` was requested. */
  total?: number;
  /** `true` when the response was served from the idempotency cache. */
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
 * Field names match `toApiStream()` in `src/routes/streams.ts` exactly.
 * Amount fields are always decimal strings.
 */
export interface Stream {
  /** Unique stream ID (format: `stream-{64-char-hex}-0`). */
  id: string;
  /** Sender Stellar public key (`G` + 55 base32 chars). Pattern: `^G[A-Z2-7]{55}$` */
  sender: string;
  /** Recipient Stellar public key. Pattern: `^G[A-Z2-7]{55}$` */
  recipient: string;
  /** Total deposit as a decimal string (e.g. `"1000000.0000000"`). */
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
  /** Sender Stellar public key. Pattern: `^G[A-Z2-7]{55}$` */
  sender: string;
  /** Recipient Stellar public key. Pattern: `^G[A-Z2-7]{55}$` */
  recipient: string;
  /**
   * Total deposit as a decimal string.
   * Must be > 0 and ≥ `ratePerSecond`.
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
 * The `data` property carries the paginated list shape.
 * Pagination state (`has_more`, `next_cursor`) lives inside `data`.
 */
export interface StreamListResponse {
  success: boolean;
  data: {
    /** Streams on this page, ordered by `id` ASC. */
    streams: Stream[];
    /** `true` when additional pages exist. */
    has_more: boolean;
    /** Opaque cursor for the next request; `null` on the last page. */
    next_cursor: string | null;
    /** Total count — only present when `include_total=true` was requested. */
    total?: number;
  };
  meta: ResponseMeta;
}

/**
 * Single-stream response from GET /api/streams/:id.
 * The stream is nested as `data.stream`.
 */
export interface StreamSingleResponse {
  success: boolean;
  data: { stream: Stream };
  meta?: ResponseMeta;
}

/**
 * Stream creation response from POST /api/streams.
 * The created stream is returned directly in `data`.
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
 * `limit` must be 1–100. `cursor` must be an opaque token from `next_cursor`.
 */
export interface ListStreamsParams {
  /** Page size (1–100). Defaults to 20 on the server. */
  limit?: number;
  /** Opaque pagination cursor from a previous `next_cursor`. Omit for the first page. */
  cursor?: string;
  /** Filter by stream status. */
  status?: string;
  /** Filter by sender Stellar address. */
  sender?: string;
  /** Filter by recipient Stellar address. */
  recipient?: string;
  /** When `true`, include `total` count in the response. */
  include_total?: boolean;
  /** Maximum pages to auto-paginate (default 10 000). */
  maxPages?: number;
}
