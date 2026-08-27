import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../../src/webhooks/dispatcher.js';
import type { WebhookCircuitBreakerStore } from '../../src/redis/webhookCircuitBreakerStore.js';

const SECRET = 'webhook-secret-1256';
const PAYLOAD = '{"address":"GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7","token":"raw-token-1256"}';
const CORRELATION_ID = 'corr-webhook-1256';

function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  return fn().then(
    () => chunks.join(''),
    (error) => {
      throw error;
    },
  ).finally(() => {
    process.stderr.write = original;
  });
}

describe('webhook diagnostic PII redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps secrets and raw payloads out of failure logs and diagnostics', async () => {
    const circuitBreakerStore = {
      checkAndClaimAttempt: vi.fn(async () => ({ allowed: true, state: 'closed' as const })),
      recordFailure: vi.fn(async () => ({ consecutiveFailures: 1 })),
      getState: vi.fn(async () => undefined),
      recordSuccess: vi.fn(),
    } as unknown as WebhookCircuitBreakerStore;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 500,
      statusText: `failure token=${SECRET}`,
    })));

    const dispatcher = new WebhookDispatcher(undefined, circuitBreakerStore);
    const output = await captureStderr(() => dispatcher.dispatch({
      url: 'http://127.0.0.1/webhook',
      secret: SECRET,
      payload: PAYLOAD,
      deliveryId: 'delivery-1256',
      eventType: 'stream.updated',
      correlationId: CORRELATION_ID,
      attemptNumber: 3,
    }));
    const result = { output };
    const serialized = `${output}${JSON.stringify(result)}`;
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PAYLOAD);
    expect(output).toContain(CORRELATION_ID);
  });
});
