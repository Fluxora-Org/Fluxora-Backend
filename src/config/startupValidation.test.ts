/**
 * Tests for startup configuration validation (issue #1437).
 *
 * Covers:
 * - Startup succeeds with valid configuration (aggregator + createApp()).
 * - Startup rejects invalid configuration for each configuration module
 *   (stellar, stellarContracts, rateLimits, health, deployment, deprecations).
 * - Errors clearly identify the invalid setting.
 * - Configuration errors surface at startup (app construction) rather than
 *   during request handling.
 */

import { describe, it, expect } from 'vitest';
import { validateStartupConfig } from './startupValidation.js';
import { ConfigError } from './env.js';
import { validateStellarConfig, STELLAR_NETWORKS } from './stellar.js';
import {
  validateStellarContractsConfig,
  STELLAR_CONTRACT_ALLOWLIST,
  STELLAR_NETWORK_PASSPHRASES,
  isValidStellarContractAddress,
} from './stellarContracts.js';
import { validateRateLimitsConfig, MAX_WINDOW_MS } from './rateLimits.js';
import { validateHealthConfig } from './health.js';
import { validateDeploymentConfig } from './deployment.js';
import { validateDeprecationsConfig } from './deprecations.js';
import { createApp } from '../app.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_TESTNET_CONTRACT = STELLAR_CONTRACT_ALLOWLIST.testnet.contract[0]!;
const VALID_TESTNET_TOKEN = STELLAR_CONTRACT_ALLOWLIST.testnet.token[0]!;

function deploymentConfig(
  overrides: Partial<Parameters<typeof validateDeploymentConfig>[0]> = {},
): Parameters<typeof validateDeploymentConfig>[0] {
  return {
    nodeEnv: 'test',
    requirePartnerAuth: false,
    partnerApiToken: undefined,
    requireAdminAuth: false,
    adminApiToken: undefined,
    redisEnabled: true,
    workerEnabled: true,
    metricsEnabled: true,
    indexerEnabled: true,
    deploymentChecklistVersion: '2026-03-27',
    ...overrides,
  };
}

function healthConfig(
  overrides: Partial<Parameters<typeof validateHealthConfig>[0]> = {},
): Parameters<typeof validateHealthConfig>[0] {
  return {
    healthCheckTimeoutMs: 5000,
    healthCheckIntervalMs: 30000,
    startupProbeBudgetMs: 30000,
    startupProbePostgresTimeoutMs: 5000,
    startupProbeRedisTimeoutMs: 3000,
    startupProbeStellarTimeoutMs: 5000,
    ...overrides,
  };
}

// ─── 1. Valid configuration starts cleanly ────────────────────────────────────

describe('validateStartupConfig() with valid configuration', () => {
  it('does not throw when every config module is valid', () => {
    expect(() => validateStartupConfig()).not.toThrow();
  });

  it('allows building the app when configuration is valid', () => {
    expect(() => createApp()).not.toThrow();
  });

  it('each per-module validator reports no issues for shipped defaults', () => {
    expect(validateStellarConfig()).toEqual([]);
    expect(validateStellarContractsConfig()).toEqual([]);
    expect(validateRateLimitsConfig(process.env)).toEqual([]);
    expect(validateHealthConfig(healthConfig())).toEqual([]);
    expect(validateDeploymentConfig(deploymentConfig())).toEqual([]);
    expect(validateDeprecationsConfig()).toEqual([]);
  });
});

// ─── 2. Per-module rejection with precise setting names ──────────────────────

describe('validateStellarConfig()', () => {
  it('rejects a non-URL horizonUrl and names the network setting', () => {
    const issues = validateStellarConfig({
      ...STELLAR_NETWORKS,
      local: { ...STELLAR_NETWORKS.local, horizonUrl: 'not a url' },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('STELLAR_NETWORKS.local.horizonUrl');
    expect(issues[0]).toContain('not a url');
  });

  it('rejects an empty passphrase', () => {
    const issues = validateStellarConfig({
      ...STELLAR_NETWORKS,
      mainnet: { ...STELLAR_NETWORKS.mainnet, passphrase: '   ' },
    });

    // An empty passphrase also trips the networkPassphrase-matches-passphrase
    // rule, so both settings are named in the reported issues.
    expect(issues).toEqual([
      expect.stringContaining('STELLAR_NETWORKS.mainnet.passphrase'),
      'STELLAR_NETWORKS.mainnet.networkPassphrase must match passphrase',
    ]);
  });

  it('rejects a networkPassphrase that drifts from passphrase', () => {
    const issues = validateStellarConfig({
      ...STELLAR_NETWORKS,
      testnet: {
        ...STELLAR_NETWORKS.testnet,
        networkPassphrase: 'Some Other Network',
      },
    });

    expect(issues).toEqual([
      expect.stringContaining('STELLAR_NETWORKS.testnet.networkPassphrase'),
    ]);
  });

  it('rejects a malformed pinned contract address', () => {
    const issues = validateStellarConfig({
      ...STELLAR_NETWORKS,
      testnet: {
        ...STELLAR_NETWORKS.testnet,
        streamingContractAddress: 'CNOTAREALCONTRACTADDRESS',
      },
    });

    expect(issues).toEqual([
      expect.stringContaining('STELLAR_NETWORKS.testnet.streamingContractAddress'),
    ]);
  });
});

describe('validateStellarContractsConfig()', () => {
  it('rejects an allowlist entry that is not a valid contract StrKey', () => {
    const issues = validateStellarContractsConfig({
      ...STELLAR_CONTRACT_ALLOWLIST,
      testnet: {
        contract: ['CBADCONTRACTADDRESS'],
        token: [VALID_TESTNET_TOKEN],
      },
    });

    expect(issues).toEqual([
      expect.stringContaining('STELLAR_CONTRACT_ALLOWLIST.testnet.contract[0]'),
    ]);
  });

  it('rejects an empty network passphrase entry', () => {
    const issues = validateStellarContractsConfig(STELLAR_CONTRACT_ALLOWLIST, {
      ...STELLAR_NETWORK_PASSPHRASES,
      local: '',
    });

    expect(issues).toEqual([
      expect.stringContaining('STELLAR_NETWORK_PASSPHRASES.local'),
    ]);
  });

  it('accepts the shipped allowlist entries as valid StrKeys', () => {
    expect(isValidStellarContractAddress(VALID_TESTNET_CONTRACT)).toBe(true);
    expect(isValidStellarContractAddress(VALID_TESTNET_TOKEN)).toBe(true);
  });
});

describe('validateRateLimitsConfig()', () => {
  it('rejects a non-integer RATE_LIMIT_IP_MAX', () => {
    const issues = validateRateLimitsConfig({ RATE_LIMIT_IP_MAX: 'abc' });

    expect(issues).toEqual([
      expect.stringContaining('RATE_LIMIT_IP_MAX must be an integer'),
    ]);
  });

  it('rejects a window above MAX_WINDOW_MS and explains why', () => {
    const issues = validateRateLimitsConfig({
      RATE_LIMIT_APIKEY_WINDOW_MS: String(MAX_WINDOW_MS + 1),
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('RATE_LIMIT_APIKEY_WINDOW_MS');
    expect(issues[0]).toContain(String(MAX_WINDOW_MS));
  });

  it('rejects a zero RATE_LIMIT_ADMIN_MAX', () => {
    const issues = validateRateLimitsConfig({ RATE_LIMIT_ADMIN_MAX: '0' });

    expect(issues).toEqual([
      expect.stringContaining('RATE_LIMIT_ADMIN_MAX must be at least 1'),
    ]);
  });

  it('accepts unset values (defaults apply)', () => {
    expect(validateRateLimitsConfig({})).toEqual([]);
  });

  it('surfaces rate-limit issues through validateStartupConfig()', () => {
    expect(() =>
      validateStartupConfig({ env: { RATE_LIMIT_IP_MAX: 'abc' } }),
    ).toThrow(ConfigError);
  });
});

describe('validateHealthConfig()', () => {
  it('rejects a non-positive healthCheckTimeoutMs', () => {
    const issues = validateHealthConfig(healthConfig({ healthCheckTimeoutMs: 0 }));

    expect(issues).toEqual([
      expect.stringContaining('healthCheckTimeoutMs must be a positive integer'),
    ]);
  });

  it('rejects a non-integer startupProbeBudgetMs', () => {
    const issues = validateHealthConfig(
      healthConfig({ startupProbeBudgetMs: 1000.5 }),
    );

    expect(issues).toEqual([
      expect.stringContaining('startupProbeBudgetMs must be a positive integer'),
    ]);
  });

  it('rejects a non-positive startupProbePostgresTimeoutMs', () => {
    const issues = validateHealthConfig(
      healthConfig({ startupProbePostgresTimeoutMs: -1 }),
    );

    expect(issues).toEqual([
      expect.stringContaining('startupProbePostgresTimeoutMs'),
    ]);
  });
});

describe('validateDeploymentConfig()', () => {
  it('rejects REQUIRE_PARTNER_AUTH without PARTNER_API_TOKEN', () => {
    const issues = validateDeploymentConfig(
      deploymentConfig({ requirePartnerAuth: true, partnerApiToken: undefined }),
    );

    expect(issues).toEqual([
      expect.stringContaining('PARTNER_API_TOKEN'),
    ]);
  });

  it('rejects REQUIRE_ADMIN_AUTH without ADMIN_API_TOKEN', () => {
    const issues = validateDeploymentConfig(
      deploymentConfig({ requireAdminAuth: true, adminApiToken: undefined }),
    );

    expect(issues).toEqual([
      expect.stringContaining('ADMIN_API_TOKEN'),
    ]);
  });

  it('rejects prod-like environments with Redis, worker, metrics, or indexer disabled', () => {
    const issues = validateDeploymentConfig(
      deploymentConfig({
        nodeEnv: 'production',
        redisEnabled: false,
        workerEnabled: false,
        metricsEnabled: false,
        indexerEnabled: false,
      }),
    );

    expect(issues).toHaveLength(4);
    expect(issues.map((i) => i.split(' ')[0])).toEqual([
      'REDIS_ENABLED',
      'WORKER_ENABLED',
      'METRICS_ENABLED',
      'INDEXER_ENABLED',
    ]);
  });

  it('rejects an empty DEPLOYMENT_CHECKLIST_VERSION', () => {
    const issues = validateDeploymentConfig(
      deploymentConfig({ deploymentChecklistVersion: '' }),
    );

    expect(issues).toEqual([
      expect.stringContaining('DEPLOYMENT_CHECKLIST_VERSION'),
    ]);
  });

  it('does not require prod parity in development or test environments', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      const issues = validateDeploymentConfig(
        deploymentConfig({
          nodeEnv,
          redisEnabled: false,
          workerEnabled: false,
          metricsEnabled: false,
          indexerEnabled: false,
        }),
      );
      expect(issues).toEqual([]);
    }
  });
});

describe('validateDeprecationsConfig()', () => {
  it('rejects a route entry with an unparseable sunsetDate', () => {
    const issues = validateDeprecationsConfig([
      { route: '/api/old', sunsetDate: 'not-a-date' },
    ]);

    expect(issues).toEqual([
      expect.stringContaining('routeDeprecations[0].sunsetDate'),
    ]);
  });

  it('rejects a route that does not start with /', () => {
    const issues = validateDeprecationsConfig([
      { route: 'api/old', sunsetDate: '2026-09-30T00:00:00.000Z' },
    ]);

    expect(issues).toEqual([
      expect.stringContaining('routeDeprecations[0].route'),
    ]);
  });

  it('rejects CR/LF injection attempts in header-bearing fields', () => {
    const issues = validateDeprecationsConfig([
      {
        route: '/api/old',
        sunsetDate: '2026-09-30T00:00:00.000Z',
        link: 'https://example.com/evil\r\nX-Injected: 1',
      },
    ]);

    expect(issues).toEqual([
      expect.stringContaining('routeDeprecations[0].link'),
    ]);
  });
});

// ─── 3. Aggregator behavior ───────────────────────────────────────────────────

describe('validateStartupConfig() aggregation', () => {
  it('throws ConfigError when a module is invalid', () => {
    let caught: unknown;
    try {
      validateStartupConfig({ env: { WEBHOOK_RETRY_RPS: '0' } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const configError = caught as ConfigError;
    expect(configError.issues).toEqual([
      expect.stringContaining('WEBHOOK_RETRY_RPS must be at least 1'),
    ]);
    expect(configError.message).toContain('WEBHOOK_RETRY_RPS');
  });

  it('collects issues from multiple modules in one error', () => {
    // Production-like NODE_ENV trips the deployment parity rules (env-defaults
    // disables Redis/worker/indexer), while the explicit env trips the
    // rate-limit rules — both must land in a single startup error.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let caught: unknown;
      try {
        validateStartupConfig({
          env: { RATE_LIMIT_IP_WINDOW_MS: String(MAX_WINDOW_MS + 1) },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigError);
      const issues = (caught as ConfigError).issues.join('\n');
      expect(issues).toContain('RATE_LIMIT_IP_WINDOW_MS');
      expect(issues).toContain('REDIS_ENABLED');
      expect(issues).toContain('WORKER_ENABLED');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

// ─── 4. Caught at startup, not during request handling ───────────────────────

describe('startup-time failure semantics', () => {
  it('createApp() throws at construction when the env is invalid', () => {
    // The app factory itself validates: an invalid deployment fails here,
    // before the HTTP server can bind or any request can reach middleware.
    expect(() =>
      createApp({ env: { RATE_LIMIT_IP_MAX: 'not-a-number' } }),
    ).toThrow(ConfigError);
  });

  it('the construction-time error names the invalid setting', () => {
    let caught: unknown;
    try {
      createApp({ env: { RATE_LIMIT_IP_MAX: 'not-a-number' } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain('RATE_LIMIT_IP_MAX');
  });
});
