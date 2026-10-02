/**
 * tests/correlationId.propagation.test.ts
 *
 * Invariant suite for #1463: assert the correlation identifier survives every
 * layer of the request path.
 *
 * ── The trail ────────────────────────────────────────────────────────────────
 *
 *   inbound x-correlation-id
 *        │
 *        ▼
 *   correlationIdMiddleware      → resolves / honours the id, opens the ALS scope
 *        │
 *        ├──▶ logger            → every log line carries it
 *        │
 *        ├──▶ JobQueue.send()   → wraps the payload in {__payload, __correlationId}
 *        │        │
 *        │        ▼  (through the database)
 *        │   JobQueue.start() worker
 *        │        │              → unwraps and re-enters correlationStore.run(id)
 *        │        ├──▶ logger    → every log line carries it again
 *        │        │
 *        │        └──▶ webhookDispatcher.dispatch() → x-correlation-id on the wire
 *        │
 *        └──▶ response headers   → x-correlation-id / x-request-id
 *
 * ── Why the job hop needs a real worker ──────────────────────────────────────
 *
 * Asserting only that `boss.send` received `__correlationId` proves the
 * producer half. The consumer half — the id being *restored* when the job
 * actually runs — is the half that silently breaks, and it only executes
 * inside the callback `boss.work()` registers. These tests therefore drive
 * that callback directly with a job round-tripped through JSON, which is what
 * the database hands the worker.
 *
 * The webhook hop is intercepted at `https.request` rather than `global.fetch`
 * because that is the transport the dispatcher actually uses; see
 * `tests/helpers/webhookTransport.ts`.
 */

import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'pg-boss';

import {
  correlationIdMiddleware,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  isValidCorrelationId,
} from '../src/middleware/correlationId';
import { correlationStore, getCorrelationId } from '../src/tracing/middleware';
import { logger } from '../src/lib/logger.js';
import { JobQueue, setJobQueue } from '../src/jobs/queue';
import { webhookDispatcher } from '../src/webhooks/dispatcher';
import { stubOutboundWebhookTransport, type WebhookTransportStub } from './helpers/webhookTransport';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A well-formed inbound identifier: UUID v4, so the middleware must honour it. */
const INBOUND_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** Job name used throughout; unique so metric/log filtering cannot collide. */
const JOB_NAME = 'correlation-id-chain';

const DELIVERY_ID = 'corr-chain-delivery';

/** Message emitted by the probe log line inside the job handler. */
const JOB_PROBE_MESSAGE = 'probe: job handler running';

/** Message emitted by the probe log line inside the request handler. */
const REQUEST_PROBE_MESSAGE = 'probe: request handler running';

// ── Log capture ───────────────────────────────────────────────────────────────

interface CapturedLog {
  timestamp: string;
  level: string;
  message: string;
  correlationId?: string;
  [key: string]: unknown;
}

interface LogCapture {
  records: CapturedLog[];
  /** Records whose message is exactly `message`. */
  byMessage(message: string): CapturedLog[];
  /** Records that carry `field=value` in their metadata. */
  withField(field: string, value: string): CapturedLog[];
  restore(): void;
}

/**
 * Intercept the structured JSON log stream.
 *
 * `logger.write` emits one JSON object per line to stdout (or stderr for
 * `error`), so patching the write methods captures exactly what a log shipper
 * would receive. Non-structured writes are ignored rather than failing the
 * parse, so unrelated output cannot break the capture.
 */
function installLogCapture(): LogCapture {
  const records: CapturedLog[] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;

  const collect = (chunk: unknown): void => {
    if (typeof chunk !== 'string') return;
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as CapturedLog).level === 'string' &&
        typeof (parsed as CapturedLog).message === 'string'
      ) {
        records.push(parsed as CapturedLog);
      }
    }
  };

  const swallow = (chunk: unknown): boolean => {
    collect(chunk);
    return true;
  };

  (process.stdout.write as unknown) = swallow;
  (process.stderr.write as unknown) = swallow;

  return {
    records,
    byMessage: (message) => records.filter((r) => r.message === message),
    withField: (field, value) => records.filter((r) => r[field] === value),
    restore: () => {
      (process.stdout.write as unknown) = originalStdout;
      (process.stderr.write as unknown) = originalStderr;
    },
  };
}

// ── Fake pg-boss ──────────────────────────────────────────────────────────────

type WorkHandler = (jobs: Job[]) => Promise<void>;

interface FakeBoss {
  boss: unknown;
  sendCalls: Array<{ name: string; data: unknown; opts: Record<string, unknown> }>;
  scheduleCalls: Array<{ name: string; cron: string; data: unknown }>;
  workHandlers: Map<string, WorkHandler>;
}

/**
 * Records producer calls and captures the consumer callback so a test can
 * deliver a job exactly the way pg-boss would.
 */
function buildFakeBoss(): FakeBoss {
  const sendCalls: FakeBoss['sendCalls'] = [];
  const scheduleCalls: FakeBoss['scheduleCalls'] = [];
  const workHandlers = new Map<string, WorkHandler>();

  const boss = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    offWork: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (name: string, data: unknown, opts: Record<string, unknown> = {}) => {
      sendCalls.push({ name, data, opts });
      return `job-${sendCalls.length}`;
    }),
    schedule: vi.fn(async (name: string, cron: string, data: unknown) => {
      scheduleCalls.push({ name, cron, data });
    }),
    work: vi.fn(async (name: string, _opts: unknown, handler: WorkHandler) => {
      workHandlers.set(name, handler);
    }),
  };

  return { boss, sendCalls, scheduleCalls, workHandlers };
}

/**
 * Build the pg-boss job record for a worker delivery.
 *
 * `data` is passed through `JSON.parse(JSON.stringify(...))` so the test sees
 * the same JSON round trip the database performs between `send` and `work`:
 * class instances, `undefined` values and prototypes do not survive it, and a
 * propagation scheme that secretly relied on them would pass otherwise.
 */
function buildJob(name: string, id: string, data: unknown): Job {
  return {
    id,
    name,
    data: JSON.parse(JSON.stringify(data)) as unknown,
  } as unknown as Job;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('correlation identifier survives every layer of the request path (#1463)', () => {
  let transport: WebhookTransportStub;
  let logs: LogCapture;
  let fake: FakeBoss;
  let queue: JobQueue;

  beforeEach(async () => {
    transport = stubOutboundWebhookTransport();
    logs = installLogCapture();
    fake = buildFakeBoss();
    queue = JobQueue.withBoss(fake.boss as never);
    setJobQueue(queue);
  });

  afterEach(() => {
    logs.restore();
    transport.restore();
    setJobQueue(null);
    vi.restoreAllMocks();
  });

  /**
   * Drive the whole trail: one HTTP request enqueues a job, the job runs, and
   * the job dispatches a webhook.
   *
   * @param handler Job body. Runs inside the worker's restored async scope, so
   *                `getCorrelationId()` inside it is the assertion subject.
   * @returns The job payload exactly as the producer handed it to pg-boss,
   *          together with the inbound id the middleware resolved.
   */
  async function traceRequestThroughJobAndWebhook(
    handler: () => Promise<void>,
    inboundId: string | undefined = INBOUND_ID,
  ): Promise<{ enqueuedData: unknown; resolvedId: string }> {
    queue.register(JOB_NAME, handler);

    const app = express();
    app.use(correlationIdMiddleware);
    app.post('/trigger', async (req, res) => {
      logger.info(REQUEST_PROBE_MESSAGE);
      try {
        await queue.send(JOB_NAME, { streamId: 'stream-1', amount: '100' });
        res.json({ correlationId: req.correlationId });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };

    try {
      const pending = request(server)
        .post('/trigger')
        .set(inboundId === undefined ? {} : { [CORRELATION_ID_HEADER]: inboundId });

      const response = await pending;
      expect(response.status).toBe(200);
      const resolvedId = response.body.correlationId as string;

      // Start the worker now that the job is enqueued, then replay the stored
      // payload through the registered consumer callback.
      await queue.start();
      const work = fake.workHandlers.get(JOB_NAME);
      if (work === undefined) throw new Error(`no worker registered for ${JOB_NAME}`);

      const sendCall = fake.sendCalls[0];
      if (sendCall === undefined) throw new Error('the request did not enqueue a job');

      await work([buildJob(JOB_NAME, 'job-1', sendCall.data)]);

      return { enqueuedData: sendCall.data, resolvedId };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('carries one identifier from the inbound header to the outbound webhook', async () => {
    const observed: { inJob: string; webhookHeader?: string } = { inJob: '' };

    const { resolvedId } = await traceRequestThroughJobAndWebhook(async () => {
      observed.inJob = getCorrelationId();
      logger.info(JOB_PROBE_MESSAGE);
      await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret',
        payload: JSON.stringify({ foo: 'bar' }),
        deliveryId: DELIVERY_ID,
        eventType: 'stream.created',
      });
    });

    // An inbound identifier that is well-formed is honoured verbatim.
    expect(resolvedId).toBe(INBOUND_ID);
    expect(isValidCorrelationId(resolvedId)).toBe(true);

    // Restored in the worker, not merely stored on the payload.
    expect(observed.inJob).toBe(INBOUND_ID);

    // Present on the outbound delivery.
    expect(transport.last().headers[CORRELATION_ID_HEADER]).toBe(INBOUND_ID);
  });

  it('stamps the resolved identifier into the enqueued job payload', async () => {
    const { enqueuedData, resolvedId } = await traceRequestThroughJobAndWebhook(async () => {
      // no-op: the job still has to be delivered so the trail completes
    });

    expect(enqueuedData).toEqual({
      __payload: { streamId: 'stream-1', amount: '100' },
      __correlationId: resolvedId,
    });
  });

  it('tags every log line emitted during the request and the job with the identifier', async () => {
    await traceRequestThroughJobAndWebhook(async () => {
      logger.info(JOB_PROBE_MESSAGE);
      await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret',
        payload: JSON.stringify({ foo: 'bar' }),
        deliveryId: DELIVERY_ID,
        eventType: 'stream.created',
      });
    });

    // Lines written by the request handler, before any async boundary.
    const requestLines = logs.byMessage(REQUEST_PROBE_MESSAGE);
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]?.correlationId).toBe(INBOUND_ID);

    // Lines written by the job handler, after the queue hop.
    const jobLines = logs.byMessage(JOB_PROBE_MESSAGE);
    expect(jobLines).toHaveLength(1);
    expect(jobLines[0]?.correlationId).toBe(INBOUND_ID);

    // Lines the dispatcher writes by itself, from inside the job. These are
    // the strongest evidence: the test never supplies the identifier, so the
    // only way they can carry it is via the ambient async scope.
    const deliveryLines = logs.withField('deliveryId', DELIVERY_ID);
    expect(deliveryLines.length).toBeGreaterThan(0);
    for (const line of deliveryLines) {
      expect(line.correlationId).toBe(INBOUND_ID);
    }
  });

  it('echoes the same identifier on both response headers', async () => {
    const app = express();
    app.use(correlationIdMiddleware);
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/ping').set(CORRELATION_ID_HEADER, INBOUND_ID);

    expect(res.headers[CORRELATION_ID_HEADER]).toBe(INBOUND_ID);
    expect(res.headers[REQUEST_ID_HEADER]).toBe(INBOUND_ID);
  });

  it('replaces a malformed inbound identifier and carries the replacement through the whole trail', async () => {
    const observed: { inJob: string } = { inJob: '' };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const { resolvedId } = await traceRequestThroughJobAndWebhook(async () => {
      observed.inJob = getCorrelationId();
      await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret',
        payload: JSON.stringify({ foo: 'bar' }),
        deliveryId: DELIVERY_ID,
        eventType: 'stream.created',
      });
    }, 'not-a-uuid');

    expect(resolvedId).not.toBe('not-a-uuid');
    expect(isValidCorrelationId(resolvedId)).toBe(true);
    expect(observed.inJob).toBe(resolvedId);
    expect(transport.last().headers[CORRELATION_ID_HEADER]).toBe(resolvedId);
    expect(warnSpy).toHaveBeenCalledWith(
      'Correlation ID rejected (invalid format), generating new ID',
    );
  });

  it('generates an identifier when the request carries none, and propagates that', async () => {
    const observed: { inJob: string } = { inJob: '' };

    const { resolvedId } = await traceRequestThroughJobAndWebhook(async () => {
      observed.inJob = getCorrelationId();
      await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret',
        payload: JSON.stringify({ foo: 'bar' }),
        deliveryId: DELIVERY_ID,
        eventType: 'stream.created',
      });
    }, undefined);

    expect(isValidCorrelationId(resolvedId)).toBe(true);
    expect(observed.inJob).toBe(resolvedId);
    expect(transport.last().headers[CORRELATION_ID_HEADER]).toBe(resolvedId);
  });

  it('hands the job handler the original payload without the transport sentinels', async () => {
    let received: unknown;
    let handlerName: string | undefined;
    let handlerJobId: string | undefined;

    queue.register(JOB_NAME, async (ctx) => {
      received = ctx.data;
      handlerName = ctx.name;
      handlerJobId = ctx.id;
    });

    const app = express();
    app.use(correlationIdMiddleware);
    app.post('/trigger', async (_req, res) => {
      await queue.send(JOB_NAME, { streamId: 'stream-1', nested: { keep: true } });
      res.json({ ok: true });
    });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      await request(server).post('/trigger').set(CORRELATION_ID_HEADER, INBOUND_ID);
      await queue.start();

      const work = fake.workHandlers.get(JOB_NAME);
      if (work === undefined) throw new Error(`no worker registered for ${JOB_NAME}`);
      await work([buildJob(JOB_NAME, 'job-77', fake.sendCalls[0]?.data)]);

      expect(received).toEqual({ streamId: 'stream-1', nested: { keep: true } });
      expect(received).not.toHaveProperty('__payload');
      expect(received).not.toHaveProperty('__correlationId');
      expect(handlerName).toBe(JOB_NAME);
      expect(handlerJobId).toBe('job-77');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to the job id when the job was enqueued outside any request', async () => {
    // No middleware ran, so there is no ambient identifier to inherit.
    expect(getCorrelationId()).toBe('unknown');

    await queue.send(JOB_NAME, { streamId: 'stream-1' });
    const enqueued = fake.sendCalls[0]?.data;
    expect(enqueued).not.toHaveProperty('__correlationId');

    let observed = '';
    queue.register(JOB_NAME, async () => {
      observed = getCorrelationId();
    });
    await queue.start();

    const work = fake.workHandlers.get(JOB_NAME);
    if (work === undefined) throw new Error(`no worker registered for ${JOB_NAME}`);
    await work([buildJob(JOB_NAME, 'job-99', enqueued)]);

    // The job id is the documented fallback, and 'unknown' never leaks into a
    // context that downstream layers would then refuse to propagate.
    expect(observed).toBe('job-99');
    expect(observed).not.toBe('unknown');
  });

  it('propagates the identifier into cron-scheduled jobs as well as immediate ones', async () => {
    await correlationStore.run(INBOUND_ID, async () => {
      await queue.schedule(JOB_NAME, '0 * * * *', { streamId: 'stream-1' });
    });

    expect(fake.scheduleCalls[0]?.data).toEqual({
      __payload: { streamId: 'stream-1' },
      __correlationId: INBOUND_ID,
    });
  });

  it('tags the failure log line of a job with the propagated identifier', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    queue.register(JOB_NAME, async () => {
      throw new Error('handler blew up');
    });

    const app = express();
    app.use(correlationIdMiddleware);
    app.post('/trigger', async (_req, res) => {
      await queue.send(JOB_NAME, {});
      res.json({ ok: true });
    });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      await request(server).post('/trigger').set(CORRELATION_ID_HEADER, INBOUND_ID);
      await queue.start();

      const work = fake.workHandlers.get(JOB_NAME);
      if (work === undefined) throw new Error(`no worker registered for ${JOB_NAME}`);

      await expect(work([buildJob(JOB_NAME, 'job-1', fake.sendCalls[0]?.data)])).rejects.toThrow(
        'handler blew up',
      );

      expect(errorSpy).toHaveBeenCalledWith(
        'Job handler failed',
        INBOUND_ID,
        expect.objectContaining({ jobName: JOB_NAME, jobId: 'job-1' }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('omits the correlation header from a delivery made with no identifier in scope', async () => {
    expect(getCorrelationId()).toBe('unknown');

    const result = await webhookDispatcher.dispatch({
      url: 'https://example.com/webhook',
      secret: 'secret',
      payload: JSON.stringify({ foo: 'bar' }),
      deliveryId: DELIVERY_ID,
      eventType: 'stream.created',
    });

    expect(result.success).toBe(true);
    // Better to omit than to send the literal 'unknown' sentinel downstream.
    expect(transport.last().headers[CORRELATION_ID_HEADER]).toBeUndefined();
  });
});
