/**
 * OpenTelemetry SDK bootstrap for Fluxora Backend.
 *
 * Must be imported BEFORE any other application module so that
 * auto-instrumentation patches are applied before the libraries load.
 *
 * Controlled by environment variables:
 *   OTEL_SDK_DISABLED=true          — skip SDK entirely (default: false)
 *   OTEL_SERVICE_NAME               — service name (default: "fluxora-backend")
 *   OTEL_EXPORTER_OTLP_ENDPOINT     — OTLP collector URL (default: "http://localhost:4318")
 *   OTEL_EXPORTER_OTLP_HEADERS      — comma-separated "key=value" auth headers (optional)
 *
 * Security notes:
 *   - OTLP endpoint is validated as a URL before use; invalid values fall back to default.
 *   - Auth headers are consumed from env only; never logged.
 *   - SDK startup errors are caught and logged; the app continues without tracing.
 *   - OTLP exporter failures are non-fatal (OTel SDK handles retries internally).
 *   - No PII is added to spans here; instrumentation libraries emit only semantic attributes.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// ── helpers ───────────────────────────────────────────────────────────────────

function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.split('=').map((s) => s.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0].length > 0),
  );
}

function safeUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    new URL(value);
    return value;
  } catch {
    return fallback;
  }
}

// ── SDK singleton ─────────────────────────────────────────────────────────────

let sdk: NodeSDK | null = null;

/**
 * Start the OpenTelemetry SDK.
 *
 * Idempotent — calling it more than once is a no-op.
 * Returns true if the SDK was started, false if disabled or already running.
 */
export function startTracing(): boolean {
  if (process.env.OTEL_SDK_DISABLED === 'true') return false;
  if (sdk !== null) return false;

  try {
    const endpoint = safeUrl(
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      'http://localhost:4318',
    );

    const exporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    });

    sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'fluxora-backend',
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
      }),
      traceExporter: exporter,
      instrumentations: [
        // Propagates W3C traceparent on inbound HTTP and outbound fetch/http calls.
        new HttpInstrumentation({
          // Suppress internal health-check noise.
          ignoreIncomingRequestHook: (req) =>
            req.url === '/health' || req.url === '/metrics',
        }),
        // Auto-instruments Express route handlers and middleware.
        new ExpressInstrumentation(),
        // Auto-instruments pg Pool.query / Client.query.
        new PgInstrumentation({ enhancedDatabaseReporting: false }),
        // Auto-instruments ioredis commands.
        new IORedisInstrumentation(),
      ],
    });

    sdk.start();
    return true;
  } catch (err) {
    // SDK startup must never crash the application.
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'OpenTelemetry SDK failed to start',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    sdk = null;
    return false;
  }
}

/**
 * Flush pending spans and shut down the SDK.
 * Call during graceful shutdown before process.exit().
 */
export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Shutdown errors are non-fatal.
  } finally {
    sdk = null;
  }
}

/** Exposed for tests only — do not call in production code. */
export function _getSdk(): NodeSDK | null {
  return sdk;
}
