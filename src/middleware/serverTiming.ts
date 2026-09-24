import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';

const SERVER_TIMING_HEADER = 'Server-Timing';
const SERVER_TIMING_ENABLED_ENV = 'SERVER_TIMING_ENABLED';
const PHASE_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/i;
const MAX_AUTH_HEADER_LENGTH = 8192;

/**
 * Architecture-neutral, safe timing names for public and production exposure.
 * Maps internal component names (database, RPC, serializers) to abstract tiers
 * so timing headers do not reveal internal component or infrastructure names.
 */
export const COMPONENT_NAME_MAP: Record<string, string> = {
  db: 'data',
  database: 'data',
  postgres: 'data',
  postgresql: 'data',
  sql: 'data',
  repository: 'data',
  model: 'data',
  serialize: 'render',
  serialization: 'render',
  json: 'render',
  template: 'render',
  stellar_rpc: 'upstream',
  rpc: 'upstream',
  horizon: 'upstream',
  http: 'upstream',
  external: 'upstream',
  cache: 'lookup',
  redis: 'lookup',
  memcached: 'lookup',
  queue: 'job',
  mq: 'job',
  worker: 'job',
  boss: 'job',
  auth: 'security',
  jwt: 'security',
  crypto: 'security',
  audit: 'security',
};

/**
 * Set of approved safe generic names that do not reveal internal component names.
 */
export const SAFE_GENERIC_NAMES = new Set([
  'total',
  'app',
  'process',
  'data',
  'render',
  'upstream',
  'lookup',
  'job',
  'security',
  'gateway',
  'compute',
  'filter',
  'transform',
  'custom',
]);

/**
 * Lightweight, request-scoped server timing registry.
 *
 * Each request gets a per-response registry that collects named timing phases
 * such as `db`, `stellar_rpc`, or `serialize`. The registry is intentionally
 * limited to a small set of sanitized values so it remains cheap and safe.
 */
export interface ServerTimingPhase {
  name: string;
  durationMs: number;
}

export interface ServerTimingRegistry {
  addPhase(name: string, durationMs: number): void;
  snapshot(): ServerTimingPhase[];
}

export interface ServerTimingOptions {
  /**
   * Explicitly enable or disable Server-Timing collection.
   * Defaults to SERVER_TIMING_ENABLED environment variable.
   */
  enabled?: boolean;
  /**
   * Explicitly set whether the middleware operates in production mode.
   * Defaults to process.env.NODE_ENV === 'production'.
   */
  isProduction?: boolean;
  /**
   * Custom authorizer for callers.
   * Defaults to isAuthorizedTimingCaller(req).
   */
  isAuthorized?: (req: Request) => boolean;
  /**
   * Custom opt-in checker.
   * Defaults to isTimingOptIn(req).
   */
  isOptIn?: (req: Request) => boolean;
  /**
   * Custom component name mapping.
   */
  nameMap?: Record<string, string>;
  /**
   * Force masking of component names even in non-production environments.
   * Defaults to process.env.SERVER_TIMING_MASK_COMPONENTS === 'true'.
   */
  maskComponentNames?: boolean;
}

interface ServerTimingState {
  registry?: ServerTimingRegistry;
}

/**
 * Best-effort constant-time string comparison to prevent timing side channels.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }
}

/**
 * Returns true if Server-Timing is enabled by environment.
 */
function isEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const value = env?.[SERVER_TIMING_ENABLED_ENV];
  if (value === undefined) return false;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Returns true if the environment represents production.
 */
export function isProductionEnvironment(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_ENV === 'production';
}

/**
 * Check whether the caller is authorized to receive timing metrics in production.
 * Authorized callers include principals with admin or operator roles, API keys
 * with administrative/timing scopes, and holders of the configured ADMIN_API_KEY
 * or SERVER_TIMING_SECRET.
 */
interface AuthenticatedRequestLike {
  user?: {
    role?: unknown;
    permissions?: unknown;
  };
  keyScopes?: unknown;
}

export function isAuthorizedTimingCaller(req: Request): boolean {
  const authReq = req as unknown as AuthenticatedRequestLike;

  // 1. Check req.user if populated by JWT auth middleware
  const user = authReq.user;
  if (user) {
    if (user.role === 'admin' || user.role === 'operator' || user.role === 'data-protection-officer') {
      return true;
    }
    if (Array.isArray(user.permissions)) {
      const perms = user.permissions;
      if (perms.includes('admin:pause') || perms.includes('admin:reindex') || perms.includes('timing:read')) {
        return true;
      }
    }
  }

  // 2. Check req.keyScopes if populated by API key auth middleware
  const keyScopes = authReq.keyScopes;
  if (Array.isArray(keyScopes)) {
    if (
      keyScopes.includes('admin') ||
      keyScopes.includes('operator') ||
      keyScopes.includes('timing') ||
      keyScopes.includes('timing:read')
    ) {
      return true;
    }
  }

  // 3. Inspect Authorization header directly
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.length <= MAX_AUTH_HEADER_LENGTH && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();

    // Check against ADMIN_API_KEY
    const adminKey = process.env.ADMIN_API_KEY;
    if (adminKey && token.length === adminKey.length && timingSafeEqual(token, adminKey)) {
      return true;
    }

    // Check against SERVER_TIMING_SECRET / SERVER_TIMING_KEY
    const timingSecret = process.env.SERVER_TIMING_SECRET || process.env.SERVER_TIMING_KEY;
    if (timingSecret && token.length === timingSecret.length && timingSafeEqual(token, timingSecret)) {
      return true;
    }

  }

  // 4. Check dedicated X-Server-Timing-Key or X-Timing-Key request header
  const timingKeyHeader = req.headers['x-server-timing-key'] ?? req.headers['x-timing-key'];
  if (typeof timingKeyHeader === 'string' && timingKeyHeader.length <= MAX_AUTH_HEADER_LENGTH) {
    const secret = process.env.SERVER_TIMING_SECRET || process.env.SERVER_TIMING_KEY || process.env.ADMIN_API_KEY;
    if (secret && timingKeyHeader.length === secret.length && timingSafeEqual(timingKeyHeader, secret)) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether the caller has explicitly opted in to receive Server-Timing headers.
 * Opt-in can be signaled via:
 * - Header `X-Server-Timing: 1` or `true` or `enabled`
 * - Header `Server-Timing: 1` or `true` or `enabled`
 * - Header `Prefer: server-timing`
 * - Query parameter `?timing=1` or `?timing=true` or `?server-timing=1`
 */
export function isTimingOptIn(req: Request): boolean {
  const xTiming = req.headers['x-server-timing'];
  if (typeof xTiming === 'string') {
    const val = xTiming.trim().toLowerCase();
    if (val === '1' || val === 'true' || val === 'enabled' || val === 'yes') {
      return true;
    }
  }

  const serverTiming = req.headers['server-timing'];
  if (typeof serverTiming === 'string') {
    const val = serverTiming.trim().toLowerCase();
    if (val === '1' || val === 'true' || val === 'enabled' || val === 'yes') {
      return true;
    }
  }

  const prefer = req.headers['prefer'];
  if (typeof prefer === 'string') {
    if (prefer.toLowerCase().includes('server-timing')) {
      return true;
    }
  }

  const timingQuery = req.query?.['timing'] ?? req.query?.['server-timing'] ?? req.query?.['server_timing'];
  if (typeof timingQuery === 'string') {
    const val = timingQuery.trim().toLowerCase();
    if (val === '1' || val === 'true' || val === 'enabled' || val === 'yes') {
      return true;
    }
  }

  return false;
}

/**
 * Map an internal phase or component name to a generic, architecture-neutral name.
 * Any unmapped name that does not belong to the approved generic safe list is
 * converted to a generic `process` label to prevent component name disclosure.
 */
export function maskPhaseName(name: string, customMap?: Record<string, string>): string {
  if (customMap && Object.prototype.hasOwnProperty.call(customMap, name)) {
    return customMap[name];
  }
  if (Object.prototype.hasOwnProperty.call(COMPONENT_NAME_MAP, name)) {
    return COMPONENT_NAME_MAP[name];
  }
  if (SAFE_GENERIC_NAMES.has(name)) {
    return name;
  }
  return 'process';
}

function sanitizeName(name: string): string | undefined {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed || !PHASE_NAME_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function sanitizeDuration(durationMs: number): number | undefined {
  if (!Number.isFinite(durationMs)) return undefined;
  if (durationMs < 0) return undefined;
  return Number(durationMs.toFixed(3));
}

function createNoopRegistry(): ServerTimingRegistry {
  return {
    addPhase() {},
    snapshot() {
      return [];
    },
  };
}

/**
 * Applies the Server-Timing header to the response if the current environment
 * and caller authorization criteria are satisfied.
 */
export function applyServerTimingHeader(
  req: Request,
  res: Response,
  registry: ServerTimingRegistry,
  options?: ServerTimingOptions,
): void {
  if (res.headersSent) {
    return;
  }

  const phases = registry.snapshot();
  if (phases.length === 0) {
    return;
  }

  const isProd = options?.isProduction ?? isProductionEnvironment(process.env);
  const shouldMask =
    isProd || options?.maskComponentNames === true || process.env.SERVER_TIMING_MASK_COMPONENTS === 'true';

  if (isProd) {
    // In production configuration:
    // 1. Detailed timings are absent by default.
    // 2. Any exposure must be opt-in AND authorised.
    const isAuthorized = options?.isAuthorized ? options.isAuthorized(req) : isAuthorizedTimingCaller(req);
    if (!isAuthorized) {
      return;
    }

    const isOptIn = options?.isOptIn ? options.isOptIn(req) : isTimingOptIn(req);
    if (!isOptIn) {
      return;
    }
  }

  const headerValue = phases
    .map((phase) => {
      const name = shouldMask ? maskPhaseName(phase.name, options?.nameMap) : phase.name;
      return `${name};dur=${phase.durationMs}`;
    })
    .join(', ');

  res.setHeader(SERVER_TIMING_HEADER, headerValue);
}

/**
 * Create an in-memory registry instance for the current request.
 *
 * The registry is attached to `res.locals` so it remains request-scoped and
 * does not require any global state or async context machinery.
 */
export function createServerTimingRegistry(): ServerTimingRegistry {
  const phases: ServerTimingPhase[] = [];

  return {
    addPhase(name: string, durationMs: number): void {
      const sanitizedName = sanitizeName(name);
      const sanitizedDuration = sanitizeDuration(durationMs);
      if (sanitizedName === undefined || sanitizedDuration === undefined) {
        return;
      }
      phases.push({ name: sanitizedName, durationMs: sanitizedDuration });
    },
    snapshot(): ServerTimingPhase[] {
      return phases.slice();
    },
  };
}

/**
 * Retrieve the current request's registry from `res.locals`.
 *
 * When the middleware is disabled or the registry has not been initialized yet,
 * this helper returns a no-op registry so the hot path remains cheap.
 */
export function getServerTimingRegistry(res: Response): ServerTimingRegistry {
  const state = res.locals?.serverTiming as ServerTimingState | undefined;
  if (state?.registry) {
    return state.registry;
  }

  if (!isEnabled(process.env)) {
    return createNoopRegistry();
  }

  const registry = createServerTimingRegistry();
  res.locals.serverTiming = { registry };
  return registry;
}

/**
 * Record a single timing phase for the current request.
 *
 * The phase name is constrained to a safe token format and the duration is
 * rounded to milliseconds to keep the header compact and reviewable.
 */
export function recordServerTimingPhase(res: Response, name: string, durationMs: number): void {
  getServerTimingRegistry(res).addPhase(name, durationMs);
}

/**
 * Express middleware that enables request-scoped Server-Timing collection.
 *
 * In development environments, detailed stage timings are emitted when enabled.
 * In production configurations, detailed timings are absent by default; any
 * exposure requires the caller to be authorized and explicitly opt-in, with
 * timing names masked so internal component names are never revealed.
 */
export function serverTimingMiddleware(
  options?: ServerTimingOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const enabled = options?.enabled ?? isEnabled(process.env);
    if (!enabled) {
      next();
      return;
    }

    const registry = createServerTimingRegistry();
    res.locals.serverTiming = { registry };

    const applyHeader = () => {
      applyServerTimingHeader(req, res, registry, options);
    };

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      applyHeader();
      return originalJson(body);
    }) as typeof res.json;

    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      applyHeader();
      return originalSend(body);
    }) as typeof res.send;

    const originalEnd = res.end.bind(res);
    res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
      applyHeader();
      if (typeof encoding === 'function') {
        return originalEnd(chunk, encoding);
      }
      return originalEnd(chunk, encoding ?? 'utf8', cb);
    }) as typeof res.end;

    const originalWrite = res.write.bind(res);
    res.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ) => {
      applyHeader();
      if (typeof encoding === 'function') {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk, encoding ?? 'utf8', cb);
    }) as typeof res.write;

    next();
  };
}
