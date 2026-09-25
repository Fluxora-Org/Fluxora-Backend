/**
 * Regression coverage for #1518 — split of `src/tracing/hooks.ts`.
 *
 * The issue asked that the 1,276-line module be separated by subsystem, that
 * the non-null assertion be replaced with a handled check, and that `console`
 * calls be replaced with structured logging, with the validation requirement
 * that "traces produced before and after the split are equivalent".
 *
 * These tests lock in the three structural guarantees plus trace equivalence:
 * 1. Module boundaries — one concern per module, each file well under 400 lines.
 * 2. Public surface — the barrel still exports every pre-split symbol, so no
 *    downstream import path or call site had to change.
 * 3. Trace equivalence — each subsystem helper still emits the same span name
 *    and attributes as before the split.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as hooks from './hooks.js';
import {
  createBatchSpanExporter,
  initializeTracer,
  resetTracer,
  traceDbQuery,
  traceRedisCommand,
  traceStellarRpc,
  traceWebhookDispatch,
  type Span,
  type TracerHooks,
} from './hooks.js';
import { traceLogError } from './traceLogger.js';

const TRACING_DIR = __dirname;

/** Modules created by the #1518 split, mapped to the concern each one owns. */
const SPLIT_MODULES: Record<string, string> = {
  'types.ts': 'shared span/hook type contracts',
  'sampling.ts': 'sampling decisions',
  'tracer.ts': 'core span lifecycle',
  'otelBridge.ts': 'OpenTelemetry adapter',
  'otelHooks.ts': 'per-subsystem hooks',
  'batchExporter.ts': 'batched export',
  'traceLogger.ts': 'structured logging for tracing internals',
  'hooks.ts': 'public barrel re-exporting the modules above',
};

const MAX_LINES = 400;

describe('#1518 module boundaries', () => {
  it('keeps every split module within the ~400-line budget', () => {
    for (const [file, concern] of Object.entries(SPLIT_MODULES)) {
      const source = readFileSync(join(TRACING_DIR, file), 'utf8');
      const lineCount = source.split('\n').length - 1;
      expect(
        lineCount,
        `${file} (${concern}) is ${lineCount} lines, over the ${MAX_LINES}-line budget`
      ).toBeLessThanOrEqual(MAX_LINES);
    }
  });

  it('splits the former monolith: hooks.ts is now a barrel over real modules', () => {
    const barrel = readFileSync(join(TRACING_DIR, 'hooks.ts'), 'utf8');
    const lineCount = barrel.split('\n').length - 1;

    // Was 1,276 lines before the split; now only a re-export surface.
    expect(lineCount).toBeLessThanOrEqual(MAX_LINES);
    expect(lineCount).toBeLessThan(200);

    // The barrel must delegate rather than reimplement.
    const reExports = barrel.match(/^export \{/gm) ?? [];
    expect(reExports.length).toBeGreaterThanOrEqual(5);

    // And the concerns must actually live in their own modules.
    const onDisk = readdirSync(TRACING_DIR);
    for (const file of Object.keys(SPLIT_MODULES)) {
      expect(onDisk, `${file} should exist in src/tracing/`).toContain(file);
    }
  });

  it('contains no console.* calls in any split module', () => {
    for (const file of Object.keys(SPLIT_MODULES)) {
      const source = readFileSync(join(TRACING_DIR, file), 'utf8');
      // Strip block/line comments so documentation prose about the previous
      // console.error calls is not mistaken for a live call.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} should not call console.* directly`).not.toMatch(/console\.\w+\(/);
    }
  });

  it('replaces the non-null assertion with a handled check', () => {
    // The pre-split `flush()` did `this.config.hooks!.onSpanEnd?.(span)`.
    const tracer = readFileSync(join(TRACING_DIR, 'tracer.ts'), 'utf8');
    expect(tracer).not.toMatch(/hooks!\./);

    // flush() must no-op when no hooks are configured, and must still drain
    // spans when an onSpanEnd handler is present.
    const drained: Span[] = [];
    const instance = initializeTracer({
      enabled: true,
      hooks: {
        onSpanEnd: (span) => {
          drained.push(span);
        },
      },
    });
    const span = instance.startSpan({ traceId: 't-flush' });
    expect(span.status).toBe('pending');

    return instance.flush().then(() => {
      expect(drained).toHaveLength(1);
      expect(drained[0].status).toBe('error');
      expect(drained[0].statusMessage).toBe('flushed at shutdown: never explicitly ended');
    });
  });

  it('flushes safely when tracing has no hooks configured at all', async () => {
    const instance = initializeTracer({ enabled: true });
    instance.startSpan({ traceId: 't-nohooks' });
    await expect(instance.flush()).resolves.toBeUndefined();
  });
});

describe('#1518 public surface is preserved', () => {
  // Every value/type-exported symbol from the pre-split hooks.ts. Type-only
  // exports are checked at compile time by `src/tracing/index.ts` and the
  // downstream call sites; this asserts the runtime values.
  const EXPECTED_RUNTIME_EXPORTS = [
    'DEFAULT_TRACER_CONFIG',
    'Tracer',
    'getTracer',
    'initializeTracer',
    'resetTracer',
    'traceSpan',
    'resolvePerRouteOverride',
    'samplingFnv1a32',
    'shouldSampleHead',
    'shouldSampleTail',
    'traceDbQuery',
    'traceRedisCommand',
    'traceStellarRpc',
    'traceWebhookDispatch',
    'recordCircuitBreakerTransition',
    'recordWsBroadcast',
    'getActiveTraceSpanIds',
    'enrichSpanWithStream',
    'enrichActiveSpanWithStream',
    'BatchSpanExporter',
    'createBatchSpanExporter',
  ];

  it.each(EXPECTED_RUNTIME_EXPORTS)('re-exports %s from ./hooks.js', (name) => {
    expect(hooks).toHaveProperty(name);
    expect((hooks as Record<string, unknown>)[name]).toBeDefined();
  });

  it('does not export a symbol that did not exist before the split', () => {
    // `traceLogError` is intentionally *not* part of the public barrel: it is
    // an internal primitive for tracing modules.
    expect(hooks).not.toHaveProperty('traceLogError');
  });
});

describe('#1518 trace equivalence', () => {
  let emitted: Span[] = [];

  const captureHooks: TracerHooks = {
    onSpanEnd: (span) => {
      emitted.push(JSON.parse(JSON.stringify(span)) as Span);
    },
  };

  beforeEach(() => {
    emitted = [];
    resetTracer();
    initializeTracer({ enabled: true, hooks: captureHooks });
  });

  afterEach(() => {
    resetTracer();
  });

  it('emits db.query with unchanged span name and attributes', async () => {
    const result = await traceDbQuery('SELECT 1', 'fluxora', async () => 42);

    expect(result).toBe(42);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].context.tags).toMatchObject({
      'span.name': 'db.query',
      'db.system': 'postgresql',
      'db.name': 'fluxora',
      'db.statement': 'SELECT 1',
    });
    expect(emitted[0].status).toBe('ok');
  });

  it('emits redis.command with unchanged span name and attributes', async () => {
    await traceRedisCommand('GET', 'stream:1', async () => 'ok');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].context.tags).toMatchObject({
      'span.name': 'redis.command',
      'db.system': 'redis',
      'db.operation': 'GET',
      'db.redis.key': 'stream:1',
    });
  });

  it('emits stellar.rpc with unchanged span name and attributes', async () => {
    await traceStellarRpc('getLatestLedger', async () => 7);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].context.tags).toMatchObject({
      'span.name': 'stellar.rpc',
      'rpc.system': 'stellar',
      'rpc.method': 'getLatestLedger',
    });
  });

  it('emits webhook.dispatch with unchanged span name and attributes', async () => {
    await traceWebhookDispatch('stream.created', 'https://example.test/hook', 2, async () => 'sent');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].context.tags).toMatchObject({
      'span.name': 'webhook.dispatch',
      'webhook.event': 'stream.created',
      'webhook.url': 'https://example.test/hook',
      'webhook.retry': 2,
    });
  });

  it('records an error status and rethrows when the wrapped operation throws', async () => {
    await expect(
      traceDbQuery('SELECT bad', 'fluxora', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].status).toBe('error');
    expect(emitted[0].statusMessage).toBe('boom');
  });

  it('keeps head-sampling decisions and route canonicalization unchanged', () => {
    // Route 100% sampled: every span kept, and the route attribute is
    // canonicalized to the override key rather than the concrete path.
    const tracer = hooks.initializeTracer({
      enabled: true,
      hooks: captureHooks,
      sampling: { strategy: 'head', sampleRate: 1, perRouteOverrides: { '/api/streams': 1 } },
    });
    const span = tracer.startSpan({
      traceId: 't-route',
      tags: { route: '/api/streams/abc' },
    });
    expect(span.context.tags?.['route']).toBe('/api/streams');
    expect(span.status).toBe('pending');
    resetTracer();
  });

  it('keeps never-sampling a no-op span', () => {
    const tracer = hooks.initializeTracer({
      enabled: true,
      hooks: captureHooks,
      sampling: { strategy: 'never' },
    });
    const span = tracer.startSpan({ traceId: 't-never' });
    expect(span.context.spanId).toBe('noop');
    resetTracer();
  });
});

describe('#1518 structured logging', () => {
  let written: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = [];
    spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('emits a single-line structured record with level, timestamp and message', () => {
    traceLogError('Tracer hook error: boom');

    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    const record = JSON.parse(written[0]);
    expect(record.level).toBe('error');
    expect(record.message).toBe('Tracer hook error: boom');
    expect(typeof record.timestamp).toBe('string');
  });

  it('keeps the stack as a top-level field, matching the pre-split record shape', () => {
    traceLogError('Tracer hook error: boom', { stack: 'Error: boom\n  at x' });

    const record = JSON.parse(written[0]);
    expect(record.stack).toBe('Error: boom\n  at x');
    expect(Object.keys(record)).toEqual(['level', 'timestamp', 'message', 'stack']);
  });

  it('redacts credential-shaped values in the message', () => {
    traceLogError('failed for password=hunter2');

    const record = JSON.parse(written[0]);
    expect(record.message).not.toContain('hunter2');
  });

  it('never throws when serialization fails', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => traceLogError('with cyclic meta', { meta: cyclic })).not.toThrow();
  });

  it('does not throw when stderr itself fails', () => {
    spy.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    expect(() => traceLogError('unwritable')).not.toThrow();
  });

  it('keeps tracer hook failures out of application code and reports them structurally', () => {
    // A hook that throws must not propagate; the failure becomes a structured
    // stderr record instead of an unhandled console.error.
    resetTracer();
    initializeTracer({
      enabled: true,
      hooks: {
        onSpanEnd: () => {
          throw new Error('exporter exploded');
        },
      },
    });
    const tracer = hooks.getTracer();
    const span = tracer.startSpan({ traceId: 't-hookfail' });

    expect(() => tracer.endSpan(span, 'ok')).not.toThrow();

    const record = JSON.parse(written[written.length - 1]);
    expect(record.level).toBe('error');
    expect(record.message).toContain('Tracer hook error: exporter exploded');
    resetTracer();
  });

  it('routes batch exporter diagnostics through structured logging', async () => {
    const exporter = createBatchSpanExporter({
      logEvents: true,
      exportHandler: () => {
        throw new Error('collector down');
      },
    });
    const span: Span = {
      context: { traceId: 't-batch', spanId: '1' },
      startTimeMs: Date.now(),
      status: 'ok',
      events: [],
    };

    exporter.onSpanEnd(span);
    await exporter.flush();

    const record = JSON.parse(written[written.length - 1]);
    expect(record.level).toBe('error');
    expect(record.message).toContain('[BatchSpanExporter]');
    expect(record.message).toContain('collector down');
  });
});
