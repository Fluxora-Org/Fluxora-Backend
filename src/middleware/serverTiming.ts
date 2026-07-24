import type { NextFunction, Request, Response } from 'express';

const SERVER_TIMING_HEADER = 'Server-Timing';
const SERVER_TIMING_ENABLED_ENV = 'SERVER_TIMING_ENABLED';
const PHASE_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/i;

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

interface ServerTimingState {
  registry?: ServerTimingRegistry;
}

function isEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const value = env?.[SERVER_TIMING_ENABLED_ENV];
  if (value === undefined) return false;
  return value.toLowerCase() === 'true' || value === '1';
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

function applyServerTimingHeader(res: Response, registry: ServerTimingRegistry): void {
  const phases = registry.snapshot();
  if (phases.length === 0) {
    return;
  }
  const headerValue = phases
    .map((phase) => `${phase.name};dur=${phase.durationMs}`)
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
 * The middleware is intentionally cheap when disabled. It only allocates a
 * lightweight registry object when `SERVER_TIMING_ENABLED=true` and writes the
 * final `Server-Timing` header near the end of the response lifecycle.
 */
export function serverTimingMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!isEnabled(process.env)) {
      next();
      return;
    }

    const registry = createServerTimingRegistry();
    res.locals.serverTiming = { registry };

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      applyServerTimingHeader(res, registry);
      return originalJson(body);
    }) as typeof res.json;

    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      applyServerTimingHeader(res, registry);
      return originalSend(body);
    }) as typeof res.send;

    const originalEnd = res.end.bind(res);
    res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
      applyServerTimingHeader(res, registry);
      if (typeof encoding === 'function') {
        return originalEnd(chunk, encoding);
      }
      return originalEnd(chunk, encoding, cb);
    }) as typeof res.end;

    const originalWrite = res.write.bind(res);
    res.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
      applyServerTimingHeader(res, registry);
      return originalWrite(chunk, encoding, cb);
    }) as typeof res.write;

    next();
  };
}
