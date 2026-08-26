/**
 * FluxoraClient — typed HTTP client for the Fluxora Backend API.
 *
 * Generated from `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
 * Do not edit by hand — run `pnpm generate:sdk:ts` instead.
 *
 * ## Design
 * - Zero external runtime dependencies — uses the standard Web `fetch` API.
 * - All monetary amounts flow as **decimal strings** (never JS numbers).
 * - Idempotency keys are auto-generated for POST /api/streams when omitted.
 * - Cursor-based pagination is encapsulated in `StreamPaginator`.
 * - The SDK performs no hidden retries; callers own retry policy and should
 *   reuse explicit idempotency keys for retried stream creation attempts.
 *
 * ## Security notes
 * - Bearer tokens and API keys are stored in memory only; never logged.
 * - Auth headers are only set when non-empty credentials are present.
 * - Client-side validation (empty/missing required params) fires before any
 *   network round-trip, reducing the attack surface for injection.
 * - TLS validation is delegated to the platform's `fetch` implementation.
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
 * ```typescript
 * const client = new FluxoraClient({
 *   baseUrl: 'https://api.fluxora.example.com',
 *   bearerToken: process.env.FLUXORA_TOKEN,
 * });
 * ```
 */
export interface FluxoraClientConfig {
  /**
   * Base URL of the Fluxora API. Trailing slashes are stripped automatically.
   * Defaults to `'http://localhost:3000'`.
   */
  baseUrl?: string;
  /**
   * Static API key sent as `X-API-Key`.
   * Can be updated at runtime via `setApiKey()`.
   */
  apiKey?: string;
  /**
   * JWT Bearer token.
   * Can be updated at runtime via `setBearerToken()`.
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
 * defined in `openapi.yaml` and mirroring `src/routes/streams.ts`.
 */
export class FluxoraClient {
  private baseUrl: string;
  private apiKey?: string;
  private bearerToken?: string;
  private headers: Record<string, string>;

  constructor(config: FluxoraClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
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
   * Update the static API key (`X-API-Key` header).
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
   * - `IdempotencyConflictError` for 409 `IDEMPOTENCY_CONFLICT`
   * - `FluxoraApiError` for all other non-2xx responses
   *
   * The dispatcher intentionally performs exactly one `fetch` call. Retry,
   * timeout, and abort policies belong to the caller or runtime `fetch`
   * implementation so SDK behavior remains deterministic across deploys.
   *
   * @param method  - HTTP verb (GET, POST, DELETE, PATCH, PUT).
   * @param path    - Request path (e.g. `'/api/streams'`).
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
    let url = `${this.baseUrl}${path}`;

    if (options.params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const headers: Record<string, string> = { ...this.headers, ...options.headers };
    if (this.bearerToken) headers['Authorization'] = `Bearer ${this.bearerToken}`;
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
   * @param role    - User role (defaults to `'viewer'`).
   * @throws {ValidationError} When `address` is empty.
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
   * Automatically generates an idempotency key when `idempotencyKey` is
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
   * ```typescript
   * const stream = await client.createStream({
   *   sender:        'GAAZI4...',
   *   recipient:     'GBBD47...',
   *   depositAmount: '1000000.0000000',
   *   ratePerSecond: '0.0000116',
   *   startTime:     Math.floor(Date.now() / 1000),
   * });
   * ```
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
   * @throws {ValidationError} When `streamId` is empty.
   * @throws {FluxoraApiError} On 404 (not found) or 503.
   */
  async getStream(streamId: string): Promise<Stream> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<StreamSingleResponse>('GET', `/api/streams/${streamId}`);
    return res.data.stream;
  }

  /**
   * GET /api/streams — List streams with cursor-based pagination.
   *
   * Returns a `StreamPaginator` which lazily fetches pages on demand.
   *
   * @param params - Optional filter and pagination parameters.
   * @returns A `StreamPaginator` instance.
   *
   * @example
   * ```typescript
   * for await (const stream of client.listStreams({ status: 'active' }).autoPaginate()) {
   *   console.log(stream.id, stream.depositAmount);
   * }
   * ```
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
   * @throws {ValidationError} When `streamId` is empty.
   * @throws {FluxoraApiError} On 404, 409 (already completed/cancelled), or 503.
   */
  async cancelStream(streamId: string): Promise<{ message: string; id: string }> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<{ success: boolean; data: { message: string; id: string } }>(
      'DELETE',
      `/api/streams/${streamId}`,
    );
    return res.data;
  }

  /**
   * PATCH /api/streams/:id/status — Transition a stream to a new lifecycle status.
   *
   * @param streamId  - The stream identifier.
   * @param newStatus - Target status (`active`, `paused`, `completed`, or `cancelled`).
   * @returns Updated stream record.
   *
   * @throws {ValidationError} When `streamId` is empty.
   * @throws {FluxoraApiError} On 409 (invalid transition) or 404.
   */
  async updateStreamStatus(
    streamId: string,
    newStatus: 'active' | 'paused' | 'completed' | 'cancelled',
  ): Promise<Stream> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<StreamCreateResponse>(
      'PATCH',
      `/api/streams/${streamId}/status`,
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
   * @param consent - Consent record; `address` identifies the user.
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
   * @throws {ValidationError} When `address` is empty.
   */
  async getPrivacyConsent(address: string): Promise<PrivacyConsent> {
    if (!address) throw new ValidationError('address is required');
    const res = await this.request<PrivacyConsentResponse>('GET', `/api/privacy/consent/${address}`);
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
      `/internal/webhooks/${id}`,
    );
    return res.data;
  }
}
