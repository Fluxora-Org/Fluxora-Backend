/**
 * Structured logging for tracing internals.
 *
 * Extracted from `src/tracing/hooks.ts` in #1518, which used raw
 * `console.error(JSON.stringify(...))` calls in two places. Those are now
 * routed through {@link traceLogError} so that tracing failures are emitted
 * as single-line structured JSON on stderr.
 *
 * ## Why not `src/lib/logger.ts`?
 *
 * `src/lib/logger.ts` is the application-wide structured logger, but it imports
 * `getCorrelationId` from `src/tracing/middleware.ts`, and `middleware.ts`
 * imports `getTracer` from the tracing barrel. Using it from inside the tracing
 * core would therefore introduce an import cycle
 * (`tracing/*` → `lib/logger` → `tracing/middleware` → `tracing/*`).
 *
 * Tracing internals sit *below* the request-scoped logger in the dependency
 * graph, so they use this small cycle-free primitive instead. The emitted
 * record shape (`level`, `timestamp`, `message`, optional `stack`) matches the
 * previous `console.error` output so log consumers see no change.
 */

import { redactKeysInString } from '../pii/sanitizer.js';

/**
 * Optional extra fields attached to a tracing-internal log record.
 *
 * `stack` is lifted to a top-level field to preserve the historical record
 * shape; every other key is spread into the record.
 */
export interface TraceLogFields {
  stack?: string;
  [key: string]: unknown;
}

/**
 * Emit a structured error record for a tracing-internal failure.
 *
 * Always writes to stderr, one line per record, and never throws: a logging
 * failure inside a failure path must not mask the original error or escape
 * into application code.
 *
 * The message is passed through `redactKeysInString` so that error text which
 * happens to embed credential-shaped values is redacted before it reaches the
 * log stream, consistent with the PII-aware contract of the tracing module.
 *
 * @param message - Human-readable description of the failure.
 * @param fields  - Optional extra fields; `stack` is emitted last.
 */
export function traceLogError(message: string, fields?: TraceLogFields): void {
  try {
    const { stack, ...rest } = fields ?? {};
    const record: Record<string, unknown> = {
      ...rest,
      level: 'error',
      timestamp: new Date().toISOString(),
      message: redactKeysInString(message),
    };
    if (stack) {
      record.stack = stack;
    }
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Structured logging must never be the reason a request fails. If the
    // record cannot be serialized we drop it rather than throw from a
    // failure path.
  }
}
