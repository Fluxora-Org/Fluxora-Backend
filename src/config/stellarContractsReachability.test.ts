/**
 * Tests for Stellar contract reachability validation (issue #1438).
 *
 * The three failure modes required by the acceptance criteria are asserted to
 * be reported *distinctly*: malformed, wrong-network, and
 * unreachable/non-existent. Existence probes use an injected client and the
 * default Soroban client uses an injected `fetch`, so no test touches the
 * network. The env-flag defaults are covered separately.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertStellarContractsReachable,
  checkStellarContractsReachability,
  classifyStellarContractAddress,
  createSorobanContractReachabilityClient,
  encodeContractInstanceLedgerKey,
  reportStellarContractReachability,
  resolveStellarContractReachabilitySettings,
  runStellarContractReachabilityCheck,
  stellarContractReachabilityIssues,
  summarizeStellarContractReachability,
  type FetchLike,
  type StellarContractReachabilityClient,
  type StellarContractReachabilityResult,
} from './stellarContractsReachability.js';
import { STELLAR_CONTRACT_ALLOWLIST } from './stellarContracts.js';
import { ConfigError } from './env.js';
import { logger } from '../lib/logger.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TESTNET_CONTRACT = STELLAR_CONTRACT_ALLOWLIST.testnet.contract[0]!;
const TESTNET_TOKEN = STELLAR_CONTRACT_ALLOWLIST.testnet.token[0]!;
const MAINNET_CONTRACT = STELLAR_CONTRACT_ALLOWLIST.mainnet.contract[0]!;

/** A well-formed StrKey that is valid but not on any pinned allowlist. */
const VALID_UNPINNED = 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM';
/** Not a contract StrKey at all (account key / wrong version byte). */
const MALFORMED = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZOR';

interface FakeClient extends StellarContractReachabilityClient {
  calls: string[];
}

function makeClient(impl: (id: string) => boolean | Promise<boolean>): FakeClient {
  const calls: string[] = [];
  return {
    calls,
    async contractExists(id: string) {
      calls.push(id);
      return impl(id);
    },
  };
}

function silenceLogger(): void {
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Classification: distinct outcomes ───────────────────────────────────────

describe('classifyStellarContractAddress()', () => {
  it('reports a malformed address as "malformed" and names the format problem', () => {
    const result = classifyStellarContractAddress('testnet', 'contract', MALFORMED);

    expect(result.outcome).toBe('malformed');
    expect(result.message).toContain('malformed');
    expect(result.message).toContain('StrKey');
  });

  it('reports a correctly-formed address pinned to another network as "wrong_network"', () => {
    const result = classifyStellarContractAddress('mainnet', 'contract', TESTNET_CONTRACT);

    expect(result.outcome).toBe('wrong_network');
    expect(result.message).toContain('pinned for testnet');
    expect(result.message).toContain('configured network is mainnet');
  });

  it('reports a well-formed but unallowlisted address as "wrong_network"', () => {
    const result = classifyStellarContractAddress('testnet', 'contract', VALID_UNPINNED);

    expect(result.outcome).toBe('wrong_network');
    expect(result.message).toContain('not in the known-good testnet contract address allowlist');
  });

  it('accepts a pinned address on its own network', () => {
    const result = classifyStellarContractAddress('testnet', 'token', TESTNET_TOKEN);

    expect(result.outcome).toBe('ok');
    expect(result.message).toContain('well-formed testnet token address');
  });
});

// ─── Acceptance: three failures reported distinctly ─────────────────────────

describe('checkStellarContractsReachability() distinct outcomes', () => {
  it('reports malformed, wrong-network and non-existent contracts as three distinct outcomes', async () => {
    silenceLogger();
    // The injected client resolves "exists = false" for any address it is asked
    // about; the other two addresses must be rejected before the probe.
    const client = makeClient(() => false);

    const results = await checkStellarContractsReachability({
      network: 'mainnet',
      addresses: {
        contract: MALFORMED, // malformed
        token: TESTNET_TOKEN, // pinned to testnet, configured for mainnet
        streaming: MAINNET_CONTRACT, // well-formed + pinned, but does not exist
      },
      client,
    });

    const malformed = results.find((r) => r.name === 'contract')!;
    const wrongNetwork = results.find((r) => r.name === 'token')!;
    const unreachable = results.find((r) => r.name === 'streaming')!;

    expect(malformed.outcome).toBe('malformed');
    expect(wrongNetwork.outcome).toBe('wrong_network');
    expect(unreachable.outcome).toBe('unreachable');

    // Three distinct outcomes and three distinct messages (not one generic error).
    expect(new Set(results.map((r) => r.outcome)).size).toBe(3);
    expect(new Set(results.map((r) => r.message)).size).toBe(3);

    expect(malformed.message).toMatch(/malformed.*StrKey/);
    expect(wrongNetwork.message).toMatch(/pinned for testnet.*configured network is mainnet/);
    expect(unreachable.message).toContain('does not exist on mainnet');

    // Only the well-formed, correctly-pinned address was probed.
    expect(client.calls).toEqual([MAINNET_CONTRACT]);
  });

  it('distinguishes an unreachable RPC from a contract that does not exist', async () => {
    silenceLogger();
    const client = makeClient(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:443');
    });

    const [result] = await checkStellarContractsReachability({
      network: 'testnet',
      addresses: { contract: TESTNET_CONTRACT },
      client,
    });

    expect(result!.outcome).toBe('unreachable');
    expect(result!.message).toContain('could not be verified on testnet');
    expect(result!.message).toContain('unable to reach Stellar RPC');
    expect(result!.message).toContain('ECONNREFUSED');
    expect(result!.message).not.toContain('does not exist');
  });

  it('reports "ok" when a pinned contract exists on the configured network', async () => {
    silenceLogger();
    const client = makeClient(() => true);

    const [result] = await checkStellarContractsReachability({
      network: 'testnet',
      addresses: { contract: TESTNET_CONTRACT },
      client,
    });

    expect(result!.outcome).toBe('ok');
    expect(result!.message).toContain('exists on testnet');
    expect(client.calls).toEqual([TESTNET_CONTRACT]);
  });

  it('skips the probe on the "local" network without calling the client', async () => {
    silenceLogger();
    const client = makeClient(() => {
      throw new Error('should never be called');
    });

    const [result] = await checkStellarContractsReachability({
      network: 'local',
      addresses: { contract: VALID_UNPINNED },
      client,
    });

    expect(result!.outcome).toBe('ok');
    expect(result!.message).toContain('reachability probe skipped');
    expect(client.calls).toEqual([]);
  });
});

// ─── Reporting: warn vs strict ───────────────────────────────────────────────

describe('reportStellarContractReachability()', () => {
  const failure: StellarContractReachabilityResult = {
    name: 'contract',
    address: TESTNET_CONTRACT,
    outcome: 'unreachable',
    message: `Contract address "contract" (${TESTNET_CONTRACT}) does not exist on testnet`,
  };

  it('logs a prominent error but does not throw by default', () => {
    silenceLogger();
    const errorSpy = vi.spyOn(logger, 'error');

    expect(() => reportStellarContractReachability([failure])).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      'stellar:contract_reachability_failed',
      undefined,
      expect.objectContaining({ strict: false, unreachable: 1 }),
    );
  });

  it('throws ConfigError in strict mode, listing each failure with its outcome', () => {
    silenceLogger();

    let caught: unknown;
    try {
      reportStellarContractReachability(
        [
          failure,
          {
            name: 'token',
            address: MALFORMED,
            outcome: 'malformed',
            message: `Contract address "token" (${MALFORMED}) is malformed: not a valid Stellar contract StrKey`,
          },
        ],
        { strict: true },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues.join('\n');
    expect(issues).toContain('[malformed]');
    expect(issues).toContain('[unreachable]');
  });

  it('logs success at info level when every address is ok', () => {
    silenceLogger();
    const infoSpy = vi.spyOn(logger, 'info');

    reportStellarContractReachability([
      { name: 'contract', address: TESTNET_CONTRACT, outcome: 'ok', message: 'exists' },
    ]);

    expect(infoSpy).toHaveBeenCalledWith(
      'stellar:contract_reachability_ok',
      undefined,
      expect.objectContaining({ checked: 1, ok: 1 }),
    );
  });

  it('summarizes and lists issues by outcome', () => {
    const results: StellarContractReachabilityResult[] = [
      { name: 'a', address: TESTNET_CONTRACT, outcome: 'ok', message: 'ok' },
      { name: 'b', address: TESTNET_CONTRACT, outcome: 'wrong_network', message: 'wrong network' },
      { name: 'c', address: TESTNET_CONTRACT, outcome: 'unreachable', message: 'unreachable' },
    ];

    expect(summarizeStellarContractReachability(results)).toEqual({
      checked: 3,
      ok: 1,
      malformed: 0,
      wrongNetwork: 1,
      unreachable: 1,
    });
    expect(stellarContractReachabilityIssues(results)).toEqual([
      '[wrong_network] wrong network',
      '[unreachable] unreachable',
    ]);
    expect(() => assertStellarContractsReachable(results)).toThrow(ConfigError);
    expect(() => assertStellarContractsReachable([results[0]!])).not.toThrow();
  });
});

// ─── Env-flag defaults ───────────────────────────────────────────────────────

describe('resolveStellarContractReachabilitySettings()', () => {
  it('is enabled by default outside NODE_ENV=test and non-strict', () => {
    expect(resolveStellarContractReachabilitySettings({})).toEqual({ enabled: true, strict: false });
    expect(resolveStellarContractReachabilitySettings({ NODE_ENV: 'development' })).toEqual({
      enabled: true,
      strict: false,
    });
    expect(resolveStellarContractReachabilitySettings({ NODE_ENV: 'production' })).toEqual({
      enabled: true,
      strict: false,
    });
  });

  it('is disabled by default under NODE_ENV=test so tests never hit the network', () => {
    expect(resolveStellarContractReachabilitySettings({ NODE_ENV: 'test' })).toEqual({
      enabled: false,
      strict: false,
    });
  });

  it('honours explicit flags and falls back on unrecognized values', () => {
    expect(
      resolveStellarContractReachabilitySettings({
        NODE_ENV: 'test',
        STELLAR_CONTRACT_REACHABILITY_CHECK: 'true',
      }),
    ).toEqual({ enabled: true, strict: false });

    expect(
      resolveStellarContractReachabilitySettings({ STELLAR_CONTRACT_REACHABILITY_CHECK: '0' }),
    ).toEqual({ enabled: false, strict: false });

    expect(
      resolveStellarContractReachabilitySettings({ STELLAR_CONTRACT_REACHABILITY_STRICT: '1' }),
    ).toEqual({ enabled: true, strict: true });

    expect(
      resolveStellarContractReachabilitySettings({
        STELLAR_CONTRACT_REACHABILITY_CHECK: 'maybe',
        STELLAR_CONTRACT_REACHABILITY_STRICT: 'perhaps',
      }),
    ).toEqual({ enabled: true, strict: false });
  });
});

// ─── Startup runner ──────────────────────────────────────────────────────────

describe('runStellarContractReachabilityCheck()', () => {
  it('skips without invoking the client when disabled', async () => {
    silenceLogger();
    const client = makeClient(() => true);

    const run = await runStellarContractReachabilityCheck({
      network: 'mainnet',
      addresses: { contract: MAINNET_CONTRACT },
      client,
      enabled: false,
    });

    expect(run).toEqual({ enabled: false, strict: false, results: [] });
    expect(client.calls).toEqual([]);
  });

  it('defaults to disabled when NODE_ENV=test', async () => {
    silenceLogger();
    const client = makeClient(() => true);

    const run = await runStellarContractReachabilityCheck({
      network: 'testnet',
      addresses: { contract: TESTNET_CONTRACT },
      client,
      env: { NODE_ENV: 'test' },
    });

    expect(run.enabled).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('runs against the active configuration and probes each contract', async () => {
    silenceLogger();
    const client = makeClient(() => true);

    const run = await runStellarContractReachabilityCheck({
      network: 'testnet',
      addresses: { contract: TESTNET_CONTRACT, token: TESTNET_TOKEN },
      client,
      enabled: true,
    });

    expect(run.enabled).toBe(true);
    expect(run.results).toHaveLength(2);
    expect(client.calls).toEqual([TESTNET_CONTRACT, TESTNET_TOKEN]);
    expect(run.results.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('rejects startup in strict mode when a contract is unreachable', async () => {
    silenceLogger();
    const client = makeClient(() => false);

    await expect(
      runStellarContractReachabilityCheck({
        network: 'testnet',
        addresses: { contract: TESTNET_CONTRACT },
        client,
        enabled: true,
        strict: true,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

// ─── Contract-instance ledger key / default Soroban client ───────────────────

describe('encodeContractInstanceLedgerKey()', () => {
  it('encodes the persistent contract-instance ledger key as 48-byte XDR', () => {
    const key = encodeContractInstanceLedgerKey(TESTNET_CONTRACT);

    // CONTRACT_DATA(6), CONTRACT address(1) + hash(32),
    // LEDGER_KEY_CONTRACT_INSTANCE(20), PERSISTENT(1).
    expect(key).toBe('AAAABgAAAAElNkdYaXqLnK2+z+DxAhMkNUZXaHmKm6y9zt/wARIjNAAAABQAAAAB');
    expect(Buffer.from(key, 'base64')).toHaveLength(48);
  });

  it('throws for a value that is not a Stellar contract StrKey', () => {
    expect(() => encodeContractInstanceLedgerKey(MALFORMED)).toThrowError(
      /not a valid Stellar contract StrKey/,
    );
  });
});

describe('createSorobanContractReachabilityClient()', () => {
  function recordingFetch(payload: unknown, status = 200): { fetchImpl: FetchLike; calls: () => number } {
    let count = 0;
    const fetchImpl: FetchLike = async () => {
      count += 1;
      return { ok: status >= 200 && status < 300, status, json: async () => payload };
    };
    return { fetchImpl, calls: () => count };
  }

  it('treats a present ledger entry as an existing contract', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, body: init.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { entries: [{ xdr: 'entry' }] } }),
      };
    };

    const client = createSorobanContractReachabilityClient({
      rpcUrl: 'https://rpc.example.com',
      fetchImpl,
    });

    await expect(client.contractExists(TESTNET_CONTRACT)).resolves.toBe(true);

    expect(requests[0]!.url).toBe('https://rpc.example.com');
    const body = JSON.parse(requests[0]!.body) as {
      method: string;
      params: { keys: string[] };
    };
    expect(body.method).toBe('getLedgerEntries');
    expect(body.params.keys).toEqual([encodeContractInstanceLedgerKey(TESTNET_CONTRACT)]);
  });

  it('treats an empty entries array as a non-existent contract', async () => {
    const { fetchImpl } = recordingFetch({ result: { entries: [] } });
    const client = createSorobanContractReachabilityClient({
      rpcUrl: 'https://rpc.example.com',
      fetchImpl,
    });

    await expect(client.contractExists(TESTNET_CONTRACT)).resolves.toBe(false);
  });

  it('throws (unreachable) on an HTTP error', async () => {
    const { fetchImpl } = recordingFetch({}, 503);
    const client = createSorobanContractReachabilityClient({
      rpcUrl: 'https://rpc.example.com',
      fetchImpl,
    });

    await expect(client.contractExists(TESTNET_CONTRACT)).rejects.toThrowError(/HTTP 503/);
  });

  it('throws (unreachable) on a JSON-RPC error payload', async () => {
    const { fetchImpl } = recordingFetch({
      error: { code: -32602, message: 'Invalid ledger key' },
    });
    const client = createSorobanContractReachabilityClient({
      rpcUrl: 'https://rpc.example.com',
      fetchImpl,
    });

    await expect(client.contractExists(TESTNET_CONTRACT)).rejects.toThrowError(
      /Invalid ledger key/,
    );
  });
});
