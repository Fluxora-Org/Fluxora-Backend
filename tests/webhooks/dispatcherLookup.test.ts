/**
 * tests/webhooks/dispatcherLookup.test.ts
 *
 * Contract suite for the dispatcher's connect-time DNS pin
 * (`lookupWebhookTarget` in `src/webhooks/dispatcher.ts`).
 *
 * The dispatcher resolves the target itself and hands the validated IP to the
 * socket layer, so a webhook cannot be re-resolved to a private address
 * between validation and connect (DNS rebinding).
 *
 * The subtlety this file pins down is the shape of Node's `lookup` callback.
 * With Happy Eyeballs — `autoSelectFamily`, the default since Node 20 — the
 * socket layer passes `all: true` and expects an *array* of
 * `{ address, family }` records. Without it, a single `(address, family)`
 * pair. Returning the wrong shape makes every outbound delivery fail with
 * `Invalid IP address: undefined` before a socket is created, which is
 * invisible to any test that stubs `https.request` and therefore never
 * exercises the lookup at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';

import { lookupWebhookTarget } from '../../src/webhooks/dispatcher.js';
import { WebhookTargetValidationError } from '../../src/webhooks/ssrfGuard.js';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

afterEach(() => vi.restoreAllMocks());

/** Invoke the lookup and resolve with the arguments the socket layer received. */
function runLookup(
  hostname: string,
  options: dns.LookupOptions,
): Promise<{ err: NodeJS.ErrnoException | null; address: string | dns.LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    (lookupWebhookTarget as unknown as (h: string, o: unknown, cb: LookupCallback) => void)(
      hostname,
      options,
      (err, address, family) => resolve({ err, address, family }),
    );
  });
}

describe('lookupWebhookTarget', () => {
  describe('all: true (Happy Eyeballs / autoSelectFamily, the Node 20+ default)', () => {
    it('returns an array of addresses, which is what the socket layer expects', async () => {
      const addresses = [
        { address: '8.8.8.8', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 },
      ];
      const lookupSpy = vi
        .spyOn(dns, 'lookup')
        .mockImplementation(((_h: any, options: any, callback: any) => {
          // The dispatcher must ask for the shape the caller requested.
          expect(options.all).toBe(true);
          callback(null, addresses);
          return undefined as never;
        }) as never);

      const result = await runLookup('webhook.test', { all: true });

      expect(lookupSpy).toHaveBeenCalledOnce();
      expect(result.err).toBeNull();
      // A bare string here is the bug: Node reads a non-array as a single
      // address, gets `undefined`, and throws "Invalid IP address: undefined".
      expect(Array.isArray(result.address)).toBe(true);
      expect(result.address).toEqual(addresses);
    });

    it('rejects when any resolved address is blocked, not just the first', async () => {
      // A benign first answer must not launder a private second answer: the
      // connect path is free to pick either one.
      vi.spyOn(dns, 'lookup').mockImplementation(((_h: any, _o: any, callback: any) => {
        callback(null, [
          { address: '8.8.8.8', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]);
        return undefined as never;
      }) as never);

      const result = await runLookup('webhook.test', { all: true });

      expect(result.err).toBeInstanceOf(Error);
      expect(result.address).toEqual([]);
    });

    it('propagates a DNS failure', async () => {
      const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      vi.spyOn(dns, 'lookup').mockImplementation(((_h: any, _o: any, callback: any) => {
        callback(failure, []);
        return undefined as never;
      }) as never);

      const result = await runLookup('webhook.test', { all: true });

      expect(result.err).toBe(failure);
    });
  });

  describe('all: false (single-address form)', () => {
    it('returns a single address and family pair', async () => {
      const lookupSpy = vi
        .spyOn(dns, 'lookup')
        .mockImplementation(((_h: any, options: any, callback: any) => {
          expect(options.all).toBe(false);
          callback(null, '8.8.8.8', 4);
          return undefined as never;
        }) as never);

      const result = await runLookup('webhook.test', { all: false });

      expect(lookupSpy).toHaveBeenCalledOnce();
      expect(result.err).toBeNull();
      expect(result.address).toBe('8.8.8.8');
      expect(result.family).toBe(4);
    });

    it('rejects a blocked address', async () => {
      vi.spyOn(dns, 'lookup').mockImplementation(((_h: any, _o: any, callback: any) => {
        callback(null, '127.0.0.1', 4);
        return undefined as never;
      }) as never);

      const result = await runLookup('webhook.test', { all: false });

      expect(result.err).toBeInstanceOf(Error);
    });

    it('accepts a bare numeric family argument', async () => {
      const lookupSpy = vi
        .spyOn(dns, 'lookup')
        .mockImplementation(((_h: any, options: any, callback: any) => {
          expect(options.family).toBe(4);
          callback(null, '8.8.8.8', 4);
          return undefined as never;
        }) as never);

      const result = await runLookup('webhook.test', 4 as unknown as dns.LookupOptions);

      expect(lookupSpy).toHaveBeenCalledOnce();
      expect(result.err).toBeNull();
      expect(result.address).toBe('8.8.8.8');
    });
  });

  it('treats an unresolvable target as a validation error rather than a crash', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((_h: any, _o: any, callback: any) => {
      callback(null, 'not-an-ip', 4);
      return undefined as never;
    }) as never);

    const result = await runLookup('webhook.test', { all: false });

    expect(result.err).toBeInstanceOf(WebhookTargetValidationError);
  });
});
