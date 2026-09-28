/**
 * Stellar contract reachability validation (issue #1438).
 *
 * `src/config/stellarContracts.ts` already validates the *format* of every
 * configured contract address (StrKey + CRC16) and pins it to a network; the
 * composed env schema calls both at load time. Neither check can tell whether
 * the address actually exists on the configured network, so a typo'd-but-valid
 * StrKey or a contract that was never deployed still boots and only fails on
 * the first RPC call — looking like a chain outage rather than a config bug.
 *
 * This module closes that gap. It reports one of four distinct outcomes per
 * configured address:
 *
 *   - `malformed`      — not a valid Stellar contract StrKey.
 *   - `wrong_network`  — valid, but pinned to a different network (or unknown
 *                        to the configured network's allowlist).
 *   - `unreachable`    — the RPC call failed, or the contract instance is not
 *                        present on the configured network.
 *   - `ok`             — well-formed, correctly pinned and present.
 *
 * The existence probe is injectable (`StellarContractReachabilityClient`) so
 * tests exercise every branch with no network access; the default
 * implementation talks to a Soroban RPC endpoint over `getLedgerEntries` using
 * the contract-instance ledger key, and its `fetch` is injectable too.
 *
 * The check is asynchronous, so it cannot live in the synchronous
 * `validateStartupConfig()` aggregator. It is invoked from the startup
 * sequence in `src/index.ts` with the *active* configuration returned by
 * `loadConfig()` (network + resolved addresses), not with the static allowlist.
 *
 * Behavior defaults (see {@link resolveStellarContractReachabilitySettings}):
 *   - enabled by default, except when `NODE_ENV=test`, so unit tests and CI
 *     never touch the network;
 *   - non-fatal by default: failures are logged at error level and startup
 *     continues. Set `STELLAR_CONTRACT_REACHABILITY_STRICT=true` to turn any
 *     failure into a `ConfigError` that aborts startup.
 */

import { logger } from '../lib/logger.js';
import { ConfigError } from './env.js';
import type { ContractAddresses, StellarNetwork } from './stellar.js';
import {
  getAddressPinnedNetwork,
  getPinnedAddressNetwork,
  isValidStellarContractAddress,
  stellarContractIdBytes,
  type PinnedStellarAddressKind,
} from './stellarContracts.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Distinct result of probing one configured contract address. */
export type StellarContractReachabilityOutcome =
  | 'ok'
  | 'malformed'
  | 'wrong_network'
  | 'unreachable';

export interface StellarContractReachabilityResult {
  /** Address key as configured (`streaming`, `contract`, `token`, …). */
  name: string;
  address: string;
  outcome: StellarContractReachabilityOutcome;
  /** Human-readable explanation; wording differs per outcome. */
  message: string;
}

/**
 * Injectable existence check. Implementations must throw on transport
 * failures (unreachable RPC, HTTP error, malformed response) rather than
 * returning `false`, so the caller can distinguish "could not verify" from
 * "verified as absent".
 */
export interface StellarContractReachabilityClient {
  /** `true` when the contract instance is present on the configured network. */
  contractExists(contractId: string): Promise<boolean>;
}

export interface ContractClassification {
  outcome: StellarContractReachabilityOutcome;
  message: string;
}

/** Minimal `fetch` surface used by the default Soroban client. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface SorobanRpcError {
  code?: number;
  message?: string;
}

interface SorobanGetLedgerEntriesResponse {
  error?: SorobanRpcError;
  result?: { entries?: unknown[] };
}

// ── Contract-instance ledger key (XDR) ────────────────────────────────────────

const LEDGER_ENTRY_TYPE_CONTRACT_DATA = 6;
const SC_ADDRESS_TYPE_CONTRACT = 1;
const SCV_LEDGER_KEY_CONTRACT_INSTANCE = 20;
const CONTRACT_DATA_DURABILITY_PERSISTENT = 1;

/**
 * Encode the base64 `LedgerKey` for a contract's instance entry, i.e. the key
 * `getLedgerEntries` needs to answer "does this contract exist?".
 *
 * XDR layout (48 bytes, big-endian):
 *   LedgerKey switch (LedgerEntryType CONTRACT_DATA = 6)
 *   contract: SCAddress switch (SC_ADDRESS_TYPE_CONTRACT = 1) + Hash(32)
 *   key:      SCVal switch (SCV_LEDGER_KEY_CONTRACT_INSTANCE = 20, void)
 *   durability: ContractDataDurability PERSISTENT = 1
 *
 * @throws when `contractId` is not a valid Stellar contract StrKey.
 */
export function encodeContractInstanceLedgerKey(contractId: string): string {
  const hash = stellarContractIdBytes(contractId);
  if (hash === null) {
    throw new Error(
      `Cannot encode contract-instance ledger key: "${contractId}" is not a valid Stellar contract StrKey`,
    );
  }

  const key = Buffer.alloc(4 + 4 + hash.length + 4 + 4);
  let offset = 0;
  offset = key.writeInt32BE(LEDGER_ENTRY_TYPE_CONTRACT_DATA, offset);
  offset = key.writeInt32BE(SC_ADDRESS_TYPE_CONTRACT, offset);
  Buffer.from(hash).copy(key, offset);
  offset += hash.length;
  offset = key.writeInt32BE(SCV_LEDGER_KEY_CONTRACT_INSTANCE, offset);
  key.writeInt32BE(CONTRACT_DATA_DURABILITY_PERSISTENT, offset);

  return key.toString('base64');
}

// ── Default Soroban RPC client ────────────────────────────────────────────────

export interface SorobanContractReachabilityClientOptions {
  /** Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`). */
  rpcUrl: string;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-call timeout in ms. Defaults to {@link DEFAULT_STELLAR_CONTRACT_REACHABILITY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** JSON-RPC request id. Defaults to 1. */
  rpcId?: number;
}

/**
 * Build the default reachability client. It asks Soroban RPC
 * `getLedgerEntries` for the contract-instance ledger key: an empty `entries`
 * array means the instance is not present.
 */
export function createSorobanContractReachabilityClient(
  options: SorobanContractReachabilityClientOptions,
): StellarContractReachabilityClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STELLAR_CONTRACT_REACHABILITY_TIMEOUT_MS;
  const rpcId = options.rpcId ?? 1;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    async contractExists(contractId: string): Promise<boolean> {
      const ledgerKey = encodeContractInstanceLedgerKey(contractId);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let payload: SorobanGetLedgerEntriesResponse;
      try {
        const response = await fetchImpl(options.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId,
            method: 'getLedgerEntries',
            params: { keys: [ledgerKey] },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Stellar RPC responded with HTTP ${response.status}`);
        }

        payload = (await response.json()) as SorobanGetLedgerEntriesResponse;
      } finally {
        clearTimeout(timer);
      }

      if (payload.error) {
        throw new Error(
          `Stellar RPC error ${payload.error.code ?? 'unknown'}: ${payload.error.message ?? 'unknown error'}`,
        );
      }

      const entries = payload.result?.entries;
      if (!Array.isArray(entries)) {
        throw new Error('Stellar RPC returned an invalid getLedgerEntries response');
      }

      return entries.length > 0;
    },
  };
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Format + network-pinning classification, mirroring the synchronous
 * `assertNetworkMatchesContracts()` rules so both layers agree. Reachability
 * (the I/O part) is layered on top by
 * {@link checkStellarContractsReachability}.
 */
export function classifyStellarContractAddress(
  network: StellarNetwork,
  name: string,
  address: string,
): ContractClassification {
  if (!isValidStellarContractAddress(address)) {
    return {
      outcome: 'malformed',
      message: `Contract address "${name}" (${address}) is malformed: not a valid Stellar contract StrKey`,
    };
  }

  if (network === 'local') {
    return {
      outcome: 'ok',
      message: `Contract address "${name}" (${address}) is well-formed (network "local" skips pinned-address checks)`,
    };
  }

  const kind: PinnedStellarAddressKind =
    name === 'token' ? 'token' : name === 'streaming' ? 'streaming' : 'contract';
  const pinnedNetwork = getPinnedAddressNetwork(kind, address);

  if (pinnedNetwork === network) {
    return {
      outcome: 'ok',
      message: `Contract address "${name}" (${address}) is a well-formed ${network} ${kind} address`,
    };
  }

  const otherPinnedNetwork = pinnedNetwork ?? getAddressPinnedNetwork(address);
  if (otherPinnedNetwork !== null) {
    return {
      outcome: 'wrong_network',
      message: `Contract address "${name}" (${address}) is pinned for ${otherPinnedNetwork} but configured network is ${network}`,
    };
  }

  return {
    outcome: 'wrong_network',
    message: `Contract address "${name}" (${address}) is not in the known-good ${network} ${kind} address allowlist`,
  };
}

// ── Reachability check ────────────────────────────────────────────────────────

export interface CheckStellarContractsReachabilityOptions {
  network: StellarNetwork;
  addresses: ContractAddresses;
  /** Existence probe. When omitted, only format/pinning is checked. */
  client?: StellarContractReachabilityClient;
  /** Probe addresses even on the `local` network. Default `false`. */
  checkLocal?: boolean;
}

async function probeContract(
  client: StellarContractReachabilityClient,
  network: StellarNetwork,
  name: string,
  address: string,
): Promise<StellarContractReachabilityResult> {
  try {
    const exists = await client.contractExists(address);
    if (exists) {
      return {
        name,
        address,
        outcome: 'ok',
        message: `Contract address "${name}" (${address}) exists on ${network}`,
      };
    }
    return {
      name,
      address,
      outcome: 'unreachable',
      message: `Contract address "${name}" (${address}) does not exist on ${network}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      name,
      address,
      outcome: 'unreachable',
      message: `Contract address "${name}" (${address}) could not be verified on ${network}: unable to reach Stellar RPC (${reason})`,
    };
  }
}

/**
 * Check every configured contract address: format, network pinning, then
 * existence on the configured network. Never throws for a bad address — the
 * outcome is reported in the result so callers can choose warn vs fatal
 * (see {@link reportStellarContractReachability}).
 *
 * Existence probes run concurrently so a slow or down RPC bounds startup at
 * one timeout rather than one per configured address; result order still
 * follows the configured address order.
 */
export async function checkStellarContractsReachability(
  options: CheckStellarContractsReachabilityOptions,
): Promise<StellarContractReachabilityResult[]> {
  const tasks: Array<Promise<StellarContractReachabilityResult>> = [];
  const probeLocal = options.checkLocal ?? false;

  for (const [name, address] of Object.entries(options.addresses)) {
    if (!address) continue;

    const classification = classifyStellarContractAddress(options.network, name, address);
    if (classification.outcome !== 'ok') {
      tasks.push(Promise.resolve({ name, address, ...classification }));
      continue;
    }

    if (options.network === 'local' && !probeLocal) {
      tasks.push(
        Promise.resolve({
          name,
          address,
          outcome: 'ok',
          message: `${classification.message}; reachability probe skipped on "local"`,
        }),
      );
      continue;
    }

    if (!options.client) {
      tasks.push(
        Promise.resolve({
          name,
          address,
          outcome: 'ok',
          message: `${classification.message}; reachability probe skipped (no RPC client)`,
        }),
      );
      continue;
    }

    // Invoked eagerly (so `contractExists` calls are observed in configured
    // order) but awaited together below.
    tasks.push(probeContract(options.client, options.network, name, address));
  }

  return Promise.all(tasks);
}

// ── Summary / strict failure ──────────────────────────────────────────────────

export interface StellarContractReachabilitySummary {
  checked: number;
  ok: number;
  malformed: number;
  wrongNetwork: number;
  unreachable: number;
}

export function summarizeStellarContractReachability(
  results: readonly StellarContractReachabilityResult[],
): StellarContractReachabilitySummary {
  const summary: StellarContractReachabilitySummary = {
    checked: results.length,
    ok: 0,
    malformed: 0,
    wrongNetwork: 0,
    unreachable: 0,
  };

  for (const result of results) {
    if (result.outcome === 'ok') summary.ok += 1;
    else if (result.outcome === 'malformed') summary.malformed += 1;
    else if (result.outcome === 'wrong_network') summary.wrongNetwork += 1;
    else summary.unreachable += 1;
  }

  return summary;
}

/**
 * One actionable line per non-`ok` address, prefixed with the outcome so the
 * three failure modes stay visually distinct in a startup error.
 */
export function stellarContractReachabilityIssues(
  results: readonly StellarContractReachabilityResult[],
): string[] {
  return results
    .filter((result) => result.outcome !== 'ok')
    .map((result) => `[${result.outcome}] ${result.message}`);
}

/** Throw the project's `ConfigError` when any address failed its check. */
export function assertStellarContractsReachable(
  results: readonly StellarContractReachabilityResult[],
): void {
  const issues = stellarContractReachabilityIssues(results);
  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
}

export interface ReportStellarContractReachabilityOptions {
  /** When true, a failure throws `ConfigError` after being logged. */
  strict?: boolean;
}

/**
 * Log the reachability outcome prominently: `stellar:contract_reachability_ok`
 * at info level when every address is fine, and
 * `stellar:contract_reachability_failed` at error level (with the per-address
 * issues) otherwise. In strict mode the failure is escalated to a
 * `ConfigError` so the startup sequence exits non-zero.
 */
export function reportStellarContractReachability(
  results: readonly StellarContractReachabilityResult[],
  options: ReportStellarContractReachabilityOptions = {},
): void {
  const summary = summarizeStellarContractReachability(results);
  const issues = stellarContractReachabilityIssues(results);

  if (issues.length === 0) {
    logger.info('stellar:contract_reachability_ok', undefined, {
      event: 'stellar_contract_reachability_ok',
      ...summary,
    });
    return;
  }

  logger.error('stellar:contract_reachability_failed', undefined, {
    event: 'stellar_contract_reachability_failed',
    strict: options.strict === true,
    ...summary,
    issues,
  });

  if (options.strict) {
    throw new ConfigError(issues);
  }
}

// ── Settings (env flags) ──────────────────────────────────────────────────────

export const DEFAULT_STELLAR_CONTRACT_REACHABILITY_TIMEOUT_MS = 5_000;

export interface StellarContractReachabilitySettings {
  /** Whether the startup probe runs at all. */
  enabled: boolean;
  /** Whether a failure aborts startup (`ConfigError`) instead of warn-only. */
  strict: boolean;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

/**
 * Resolve the reachability settings from the environment.
 *
 * `STELLAR_CONTRACT_REACHABILITY_CHECK` defaults to `true` everywhere except
 * `NODE_ENV=test`, where it defaults to `false` so unit/CI runs never perform
 * network I/O. `STELLAR_CONTRACT_REACHABILITY_STRICT` defaults to `false`, so a
 * bad contract is reported prominently without taking the service down.
 * Unrecognized values fall back to the defaults.
 */
export function resolveStellarContractReachabilitySettings(
  env: Record<string, string | undefined> = process.env,
): StellarContractReachabilitySettings {
  const explicitCheck = parseBooleanFlag(env.STELLAR_CONTRACT_REACHABILITY_CHECK);
  const explicitStrict = parseBooleanFlag(env.STELLAR_CONTRACT_REACHABILITY_STRICT);

  return {
    enabled: explicitCheck ?? env.NODE_ENV !== 'test',
    strict: explicitStrict ?? false,
  };
}

// ── Startup runner ────────────────────────────────────────────────────────────

export interface RunStellarContractReachabilityCheckOptions {
  network: StellarNetwork;
  addresses: ContractAddresses;
  /** Environment for flag resolution (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Injected client (tests); otherwise built from `rpcUrl`. */
  client?: StellarContractReachabilityClient;
  /** Soroban RPC endpoint used to build the default client. */
  rpcUrl?: string;
  /** Per-call timeout for the default client. */
  timeoutMs?: number;
  /** Injectable fetch for the default client (tests). */
  fetchImpl?: FetchLike;
  /** Override the resolved `enabled` flag (tests). */
  enabled?: boolean;
  /** Override the resolved `strict` flag (tests). */
  strict?: boolean;
  /** Probe addresses even on the `local` network. Default `false`. */
  checkLocal?: boolean;
}

export interface StellarContractReachabilityRunResult {
  enabled: boolean;
  strict: boolean;
  results: StellarContractReachabilityResult[];
}

/**
 * Startup entry point: resolve the flags, build the default client when one is
 * not injected, check the active configuration, and report the result. Throws
 * `ConfigError` only when strict mode is on and a check failed.
 */
export async function runStellarContractReachabilityCheck(
  options: RunStellarContractReachabilityCheckOptions,
): Promise<StellarContractReachabilityRunResult> {
  const settings = resolveStellarContractReachabilitySettings(options.env);
  const enabled = options.enabled ?? settings.enabled;
  const strict = options.strict ?? settings.strict;

  if (!enabled) {
    logger.info('stellar:contract_reachability_skipped', undefined, {
      event: 'stellar_contract_reachability_skipped',
      network: options.network,
      reason: 'disabled by STELLAR_CONTRACT_REACHABILITY_CHECK or NODE_ENV=test',
    });
    return { enabled, strict, results: [] };
  }

  const client =
    options.client ??
    (options.rpcUrl
      ? createSorobanContractReachabilityClient({
          rpcUrl: options.rpcUrl,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        })
      : undefined);

  if (!client) {
    logger.warn('stellar:contract_reachability_no_client', undefined, {
      event: 'stellar_contract_reachability_no_client',
      network: options.network,
      reason: 'no Stellar RPC URL configured; existence was not verified',
    });
  }

  const results = await checkStellarContractsReachability({
    network: options.network,
    addresses: options.addresses,
    client,
    checkLocal: options.checkLocal,
  });

  reportStellarContractReachability(results, { strict });

  return { enabled, strict, results };
}
