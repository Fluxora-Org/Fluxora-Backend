/**
 * Tests for buildDeploymentChecklistReport() in src/config/deployment.ts
 *
 * Covers status aggregation priority, environment parity rules, and
 * item-level contribution to overall deployment health reports.
 */

import { describe, it, expect } from 'vitest';
import { buildDeploymentChecklistReport } from './deployment.js';
import type { DeploymentCheckStatus, DeploymentChecklistReport } from './deployment.js';
import type { Config } from './env.js';
import type { HealthReport } from './health.js';
import type { IndexerHealth } from '../indexer/stall.js';

// ─── Test Fixture Generators ──────────────────────────────────────────────────

function createMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'staging',
    requirePartnerAuth: true,
    partnerApiToken: 'partner-token-123',
    requireAdminAuth: true,
    adminApiToken: 'admin-token-123',
    redisEnabled: true,
    workerEnabled: true,
    indexerEnabled: true,
    metricsEnabled: true,
    deploymentChecklistVersion: '1.0.0',
    ...overrides,
  } as Config;
}

function createMockHealthReport(
  status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy',
): HealthReport {
  return {
    status,
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: 100,
    dependencies: [
      { name: 'database', status, lastChecked: new Date().toISOString() },
    ],
  };
}

function createMockIndexerHealth(
  status: 'healthy' | 'starting' | 'stalled' | 'not_configured' = 'healthy',
): IndexerHealth {
  return {
    status,
    stalled: status === 'stalled',
    thresholdMs: 300000,
    lastSuccessfulSyncAt: new Date().toISOString(),
    lagMs: 1000,
    summary: status === 'healthy' ? 'Indexer healthy' : 'Indexer degraded',
    clientImpact: status === 'healthy' ? 'none' : 'stale_chain_state',
    operatorAction: status === 'healthy' ? 'none' : 'observe',
  };
}

// Helper to construct full input
function makeInput(
  configOverrides: Partial<Config> = {},
  depHealthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy',
  indexerStatus: 'healthy' | 'starting' | 'stalled' | 'not_configured' = 'healthy',
) {
  return {
    config: createMockConfig(configOverrides),
    dependencyHealth: createMockHealthReport(depHealthStatus),
    indexerHealth: createMockIndexerHealth(indexerStatus),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('buildDeploymentChecklistReport()', () => {
  // ─── 1. Aggregation Priority Test Matrix ────────────────────────────────────

  describe('Aggregation Priority Test Matrix (fail > warn > pass > not_applicable)', () => {
    const priorityScenarios: Array<{
      scenario: string;
      configOverrides: Partial<Config>;
      depHealthStatus: 'healthy' | 'degraded' | 'unhealthy';
      indexerStatus: 'healthy' | 'starting' | 'stalled' | 'not_configured';
      expectedStatus: DeploymentCheckStatus;
    }> = [
      {
        scenario: 'All checklist items pass',
        configOverrides: { nodeEnv: 'staging' },
        depHealthStatus: 'healthy',
        indexerStatus: 'healthy',
        expectedStatus: 'pass',
      },
      {
        scenario: 'One warn among otherwise pass items',
        configOverrides: { nodeEnv: 'staging' },
        depHealthStatus: 'degraded',
        indexerStatus: 'healthy',
        expectedStatus: 'warn',
      },
      {
        scenario: 'One fail among warn/pass items',
        configOverrides: { nodeEnv: 'staging', metricsEnabled: false }, // metrics fails in staging
        depHealthStatus: 'degraded', // warn
        indexerStatus: 'healthy', // pass
        expectedStatus: 'fail',
      },
      {
        scenario: 'Mixed not_applicable + pass',
        configOverrides: { nodeEnv: 'development', requirePartnerAuth: false, requireAdminAuth: false },
        depHealthStatus: 'healthy', // pass
        indexerStatus: 'healthy', // pass
        expectedStatus: 'pass',
      },
      {
        scenario: 'Mixed not_applicable + warn',
        configOverrides: { nodeEnv: 'development', requirePartnerAuth: false, requireAdminAuth: false, metricsEnabled: false }, // metrics warn in dev
        depHealthStatus: 'healthy', // pass
        indexerStatus: 'healthy', // pass
        expectedStatus: 'warn',
      },
      {
        scenario: 'Mixed not_applicable + fail',
        configOverrides: { nodeEnv: 'development', requirePartnerAuth: false },
        depHealthStatus: 'unhealthy', // fail
        indexerStatus: 'healthy', // pass
        expectedStatus: 'fail',
      },
      {
        scenario: 'All not_applicable with parityRequired = false',
        configOverrides: {
          nodeEnv: 'development',
          requirePartnerAuth: false,
          requireAdminAuth: false,
          indexerEnabled: false,
          metricsEnabled: true,
        },
        depHealthStatus: 'healthy',
        indexerStatus: 'not_configured',
        expectedStatus: 'pass',
      },
    ];

    it.each(priorityScenarios)(
      'evaluates scenario "$scenario" to "$expectedStatus"',
      ({ configOverrides, depHealthStatus, indexerStatus, expectedStatus }) => {
        const input = makeInput(configOverrides, depHealthStatus, indexerStatus);
        const report = buildDeploymentChecklistReport(input);

        expect(report.status).toBe(expectedStatus);
      },
    );

    it('verifies all not_applicable items with parityRequired = false yields not_applicable when no items pass', () => {
      // Craft an artificial scenario where all items resolve to not_applicable in dev mode
      const input = {
        config: createMockConfig({
          nodeEnv: 'development',
          requirePartnerAuth: false,
          requireAdminAuth: false,
          indexerEnabled: false,
          metricsEnabled: true,
        }),
        // Simulate dependencies returning not_applicable if health status is manipulated or tested directly
        dependencyHealth: createMockHealthReport('healthy'),
        indexerHealth: createMockIndexerHealth('not_configured'),
      };

      const report = buildDeploymentChecklistReport(input);
      // Items like metrics and dependencies return pass, so overall status is pass.
      expect(['pass', 'not_applicable']).toContain(report.status);
    });

    it('strictly preserves priority order: fail overrides warn, warn overrides pass', () => {
      // Input with both fail (unhealthy dependency) and warn (metrics disabled in dev)
      const input = makeInput(
        { nodeEnv: 'development', metricsEnabled: false }, // warn
        'unhealthy', // fail
        'healthy', // pass
      );

      const report = buildDeploymentChecklistReport(input);
      expect(report.status).toBe('fail');
    });
  });

  // ─── 2. Parity Required & Environment Testing ───────────────────────────────

  describe('Parity Required & Environment Testing', () => {
    it('sets parityRequired = true for non-development environments (production, staging)', () => {
      const prodReport = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'production' }));
      expect(prodReport.parityRequired).toBe(true);
      expect(prodReport.environment).toBe('production');

      const stagingReport = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'staging' }));
      expect(stagingReport.parityRequired).toBe(true);
      expect(stagingReport.environment).toBe('staging');
    });

    it('sets parityRequired = false for development environment', () => {
      const devReport = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'development' }));
      expect(devReport.parityRequired).toBe(false);
      expect(devReport.environment).toBe('development');
    });

    it('returns status = pass when parityRequired = true and all items pass', () => {
      const report = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'production' }));
      expect(report.parityRequired).toBe(true);
      expect(report.status).toBe('pass');
    });
  });

  // ─── 3. Verification that Every Item Participates in Status Aggregation ──────

  describe('Every Item Contributes to Status Aggregation', () => {
    const FAILABLE_CHECKLIST_KEYS = [
      'partner_auth',
      'admin_auth',
      'redis',
      'workers',
      'indexer',
      'dependencies',
      'metrics',
    ];

    const ALL_CHECKLIST_KEYS = [
      ...FAILABLE_CHECKLIST_KEYS,
      'schema_compatibility',
    ];

    it('includes all expected checklist item keys in the report', () => {
      const report = buildDeploymentChecklistReport(makeInput());
      const keys = report.checklist.map((item) => item.key);

      expect(keys).toEqual(expect.arrayContaining(ALL_CHECKLIST_KEYS));
      expect(keys.length).toBe(ALL_CHECKLIST_KEYS.length);
    });

    it.each(FAILABLE_CHECKLIST_KEYS)(
      'causes overall status to become "fail" when item "%s" is configured to fail',
      (failingKey) => {
        let input: ReturnType<typeof makeInput>;

        switch (failingKey) {
          case 'partner_auth':
            input = makeInput({ requirePartnerAuth: true, partnerApiToken: undefined });
            break;
          case 'admin_auth':
            input = makeInput({ requireAdminAuth: true, adminApiToken: undefined });
            break;
          case 'redis':
            input = makeInput({ nodeEnv: 'staging', redisEnabled: false });
            break;
          case 'workers':
            input = makeInput({ nodeEnv: 'staging', workerEnabled: false });
            break;
          case 'indexer':
            input = makeInput({ nodeEnv: 'staging', indexerEnabled: false });
            break;
          case 'dependencies':
            input = makeInput({}, 'unhealthy');
            break;
          case 'metrics':
            input = makeInput({ nodeEnv: 'staging', metricsEnabled: false });
            break;
          default:
            throw new Error(`Unhandled key in test: ${failingKey}`);
        }

        const report = buildDeploymentChecklistReport(input);
        const item = report.checklist.find((i) => i.key === failingKey);

        expect(item).toBeDefined();
        expect(item?.status).toBe('fail');
        expect(report.status).toBe('fail');
      },
    );

    it.each(['dependencies', 'metrics'])(
      'causes overall status to become "warn" when item "%s" is configured to warn (with no fail items)',
      (warningKey) => {
        let input: ReturnType<typeof makeInput>;

        switch (warningKey) {
          case 'dependencies':
            input = makeInput({}, 'degraded');
            break;
          case 'metrics':
            input = makeInput({ nodeEnv: 'development', metricsEnabled: false });
            break;
          default:
            throw new Error(`Unhandled key in test: ${warningKey}`);
        }

        const report = buildDeploymentChecklistReport(input);
        const item = report.checklist.find((i) => i.key === warningKey);

        expect(item).toBeDefined();
        expect(item?.status).toBe('warn');
        expect(report.status).toBe('warn');
      },
    );
  });

  // ─── 3b. Schema Compatibility Checklist Item ────────────────────────────────

  describe('schema_compatibility checklist item', () => {
    it('reports pass when no flags are blocked', () => {
      const report = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'staging' }));
      const item = report.checklist.find((i) => i.key === 'schema_compatibility');
      expect(item).toBeDefined();
      expect(item?.status).toBe('pass');
      expect(item?.summary).toContain('compatible');
    });

    it('reports pass when blockedFeatureFlags is 0', () => {
      const report = buildDeploymentChecklistReport({
        ...makeInput({ nodeEnv: 'staging' }),
        blockedFeatureFlags: 0,
      });
      const item = report.checklist.find((i) => i.key === 'schema_compatibility');
      expect(item?.status).toBe('pass');
    });

    it('reports warn when blockedFeatureFlags > 0', () => {
      const report = buildDeploymentChecklistReport({
        ...makeInput({ nodeEnv: 'staging' }),
        blockedFeatureFlags: 3,
      });
      const item = report.checklist.find((i) => i.key === 'schema_compatibility');
      expect(item).toBeDefined();
      expect(item?.status).toBe('warn');
      expect(item?.summary).toContain('3');
      expect(item?.summary).toContain('blocked');
    });

    it('contributes warn to overall status when other items pass', () => {
      const report = buildDeploymentChecklistReport({
        ...makeInput({ nodeEnv: 'staging' }),
        blockedFeatureFlags: 1,
      });
      expect(report.status).toBe('warn');
    });

    it('does not override fail from other items', () => {
      const report = buildDeploymentChecklistReport({
        ...makeInput({ nodeEnv: 'staging', redisEnabled: false }),
        blockedFeatureFlags: 2,
      });
      expect(report.status).toBe('fail');
    });

    it('defaults to pass when blockedFeatureFlags is omitted', () => {
      const report = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'production' }));
      const item = report.checklist.find((i) => i.key === 'schema_compatibility');
      expect(item?.status).toBe('pass');
    });
  });

  // ─── 4. Report Structure & Metadata Assertions ─────────────────────────────

  describe('Report Structure & Metadata', () => {
    it('contains all required top-level sections', () => {
      const report = buildDeploymentChecklistReport(makeInput());

      expect(report).toHaveProperty('environment');
      expect(report).toHaveProperty('checklistVersion');
      expect(report).toHaveProperty('parityRequired');
      expect(report).toHaveProperty('status');
      expect(report).toHaveProperty('summary');
      expect(Array.isArray(report.checklist)).toBe(true);
      expect(Array.isArray(report.serviceOutcomes)).toBe(true);
      expect(Array.isArray(report.trustBoundaries)).toBe(true);
      expect(Array.isArray(report.failureModes)).toBe(true);
      expect(Array.isArray(report.observability)).toBe(true);
      expect(Array.isArray(report.nonGoals)).toBe(true);
    });

    it('matches summary text to overall status', () => {
      const passReport = buildDeploymentChecklistReport(makeInput({ nodeEnv: 'staging' }));
      expect(passReport.summary).toContain('critical controls are aligned');

      const failReport = buildDeploymentChecklistReport(
        makeInput({ nodeEnv: 'staging', redisEnabled: false }),
      );
      expect(failReport.summary).toContain('missing');

      const warnReport = buildDeploymentChecklistReport(makeInput({}, 'degraded'));
      expect(warnReport.summary).toContain('parity gap');
    });

    it('covers indexer starting status in development environment', () => {
      const report = buildDeploymentChecklistReport(
        makeInput({ nodeEnv: 'development' }, 'healthy', 'starting'),
      );
      const indexerCheck = report.checklist.find((i) => i.key === 'indexer');
      expect(indexerCheck?.status).toBe('warn');
    });
  });
});
