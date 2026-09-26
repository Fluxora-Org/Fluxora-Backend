/**
 * tests/helpers/webhookTransport.ts
 *
 * Test seam for outbound webhook deliveries.
 *
 * `src/webhooks/dispatcher.ts` sends deliveries through `node:https` (not
 * `fetch`) so it can pin the resolved IP via a custom `lookup` and defeat DNS
 * rebinding. Stubbing `global.fetch` therefore does nothing: the dispatcher
 * opens a real socket, the sandbox has no outbound network, and the delivery
 * fails before any assertion about `x-correlation-id` can run.
 *
 * This helper intercepts at the actual transport boundary — `https.request` —
 * so tests can observe the exact headers the dispatcher attaches to the wire
 * without performing any network I/O.
 */

import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';

export interface CapturedDelivery {
  /** Absolute URL the dispatcher resolved and dialed. */
  url: string;
  method: string | undefined;
  /** Outbound headers, lower-cased for stable assertions. */
  headers: Record<string, string>;
  body: string;
}

export interface WebhookTransportStub {
  /** One entry per attempted delivery, in order. */
  deliveries: CapturedDelivery[];
  /** Convenience accessor for the single delivery a test expects. */
  last(): CapturedDelivery;
  /** Removes the stub. Safe to call more than once. */
  restore(): void;
}

export interface StubResponse {
  status: number;
  statusMessage?: string;
  headers?: Record<string, string>;
}

function toHeaderRecord(headers: OutgoingHttpHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * Replace `https.request` with a stub that records deliveries and replies with
 * a canned response.
 *
 * @param respond Maps a captured delivery to the response the receiver
 *                "sends". Defaults to a bare `200`.
 */
export function stubOutboundWebhookTransport(
  respond: (delivery: CapturedDelivery) => StubResponse = () => ({ status: 200 }),
): WebhookTransportStub {
  const deliveries: CapturedDelivery[] = [];

  const spy = ((): unknown => {
    const original = https.request;

    https.request = function stubbedRequest(
      url: string | URL,
      options: unknown,
      callback?: (res: IncomingMessage) => void,
    ) {
      const resolvedUrl = typeof url === 'string' ? url : url.toString();
      const opts = (options ?? {}) as { headers?: OutgoingHttpHeaders; method?: string };

      const delivery: CapturedDelivery = {
        url: resolvedUrl,
        method: opts.method,
        headers: toHeaderRecord(opts.headers),
        body: '',
      };
      deliveries.push(delivery);

      const request = new EventEmitter() as EventEmitter & { end: (body?: string) => void };
      request.end = (body?: string) => {
        delivery.body = typeof body === 'string' ? body : '';

        const reply = respond(delivery);
        const response = new EventEmitter() as EventEmitter & Partial<IncomingMessage>;
        response.statusCode = reply.status;
        response.statusMessage = reply.statusMessage ?? '';
        response.headers = reply.headers ?? {};
        response.resume = () => response;

        // Deliver asynchronously, the way a real socket would, so callers
        // cannot accidentally depend on synchronous resolution.
        setImmediate(() => callback?.(response as IncomingMessage));
      };

      return request;
    } as unknown as typeof https.request;

    return () => {
      https.request = original;
    };
  })();

  return {
    deliveries,
    last: () => {
      const delivery = deliveries[deliveries.length - 1];
      if (delivery === undefined) {
        throw new Error('stubOutboundWebhookTransport: no delivery was attempted');
      }
      return delivery;
    },
    restore: spy,
  };
}
