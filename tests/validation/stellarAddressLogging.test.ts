/**
 * Observability contract for src/validation/stellarAddressValidator.ts (issue #1442).
 *
 * Acceptance criteria covered here:
 *  - No `console` call remains in the module.
 *  - Validation failures carry the request correlation identifier.
 *  - Repeated failures from one source are observable as a bounded metric.
 *  - Valid addresses are not logged.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StellarAddressValidator } from '../../src/validation/stellarAddressValidator.js';
import { logger } from '../../src/lib/logger.js';
import { correlationStore } from '../../src/tracing/middleware.js';
import { stellarAddressValidationFailuresTotal } from '../../src/metrics/stellarAddressMetrics.js';
import { CircuitOpenError } from '../../src/services/stellar-rpc.js';
import type { StellarRpcService } from '../../src/services/stellar-rpc.js';

const VALID_SENDER = 'GAAREIZUIVLGO6EJTKV3ZTO654ABCIRTIRKWM54ITGVLXTG5537RAI5F';
const VALID_RECIPIENT = 'GBNWY7MOT6YMDUXD6QCRMJZYJFNGW7ENT2X4BUPC6MCBKJRXJBMWUCQH';
// Structurally valid account StrKey that the configured network reports absent.
const WRONG_NETWORK_ACCOUNT = 'GCV3ZTO654ABCIRTIRKWM54ITGVLXTG5537RAIJSINKGK5UHTCU3V7YT';
// Valid StrKey of the wrong kind (muxed) for an account field.
const MUXED_ADDRESS = 'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5IG';

function makeRpc(responses: Record<string, boolean | Error>): StellarRpcService {
  return {
    accountExists: vi.fn(async (address: string) => {
      const r = responses[address];
      if (r instanceof Error) throw r;
      return r ?? false;
    }),
  } as unknown as StellarRpcService;
}

/** Read the current value of one labelled series of the failure counter. */
function metricCount(reason: string): number {
  const snapshot = stellarAddressValidationFailuresTotal.get();
  const match = snapshot.values.find((value) => value.labels.reason === reason);
  return match?.value ?? 0;
}

describe('StellarAddressValidator observability', () => {
  beforeEach(() => {
    stellarAddressValidationFailuresTotal.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains no console call', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/validation/stellarAddressValidator.ts', import.meta.url)),
      'utf8'
    );
    expect(source).not.toMatch(/console\./);
  });

  it('logs a malformed rejection with the request correlation identifier', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const validator = new StellarAddressValidator(makeRpc({}), null, 300, 'testnet');

    await correlationStore.run('corr-malformed-1', async () => {
      const result = await validator.validate(MUXED_ADDRESS, VALID_RECIPIENT);
      expect(result.valid).toBe(false);
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'stellar address validation failed',
      'corr-malformed-1',
      expect.objectContaining({ reason: 'malformed', count: 1, network: 'testnet' })
    );
  });

  it('logs a wrong-network rejection with the request correlation identifier', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const rpc = makeRpc({ [VALID_SENDER]: true, [WRONG_NETWORK_ACCOUNT]: false });
    const validator = new StellarAddressValidator(rpc, null, 300, 'testnet');

    await correlationStore.run('corr-wrong-network-1', async () => {
      const result = await validator.validate(VALID_SENDER, WRONG_NETWORK_ACCOUNT);
      expect(result.valid).toBe(false);
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'stellar address validation failed',
      'corr-wrong-network-1',
      expect.objectContaining({ reason: 'wrong-network', count: 1, network: 'testnet' })
    );
  });

  it('does not log valid addresses', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const rpc = makeRpc({ [VALID_SENDER]: true, [VALID_RECIPIENT]: true });
    const validator = new StellarAddressValidator(rpc, null, 300, 'testnet');

    const result = await validator.validate(VALID_SENDER, VALID_RECIPIENT);

    expect(result.valid).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('increments the bounded failure metric once per rejected validation', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const rpc = makeRpc({ [VALID_SENDER]: true, [WRONG_NETWORK_ACCOUNT]: false });
    const validator = new StellarAddressValidator(rpc, null, 300, 'testnet');

    expect(metricCount('wrong-network')).toBe(0);
    await validator.validate(VALID_SENDER, WRONG_NETWORK_ACCOUNT);
    await validator.validate(VALID_SENDER, WRONG_NETWORK_ACCOUNT);
    expect(metricCount('wrong-network')).toBe(2);
  });

  it('counts RPC fail-open as rpc-unavailable and keeps the request passing', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const rpc = makeRpc({
      [VALID_SENDER]: new CircuitOpenError(),
      [VALID_RECIPIENT]: new CircuitOpenError(),
    });
    const validator = new StellarAddressValidator(rpc, null, 300, 'testnet');

    await correlationStore.run('corr-rpc-1', async () => {
      const result = await validator.validate(VALID_SENDER, VALID_RECIPIENT);
      expect(result.valid).toBe(true);
    });

    expect(metricCount('rpc-unavailable')).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circuit breaker OPEN'),
      'corr-rpc-1',
      expect.objectContaining({ network: 'testnet' })
    );
  });
});
