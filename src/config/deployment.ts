import type { Config } from './env.js';
import type { HealthReport } from './health.js';
import type { IndexerHealth } from '../indexer/stall.js';

export type DeploymentCheckStatus = 'pass' | 'warn' | 'fail' | 'not_applicable';

export interface DeploymentChecklistItem {
  key: string;
  title: string;
  status: DeploymentCheckStatus;
  summary: string;
}

export interface ServiceOutcome {
  area: string;
  guarantee: string;
}

export interface TrustBoundary {
  actor: 'public_internet_client' | 'authenticated_partner' | 'administrator' | 'internal_worker';
  may: string[];
  mayNot: string[];
}

export interface FailureModeDefinition {
  key: string;
  trigger: string;
  clientVisibleBehavior: string;
  operatorExpectation: string;
}

export interface ObservabilitySignal {
  signal: string;
  purpose: string;
}

export interface DeploymentChecklistReport {
  environment: Config['nodeEnv'];
  checklistVersion: string;
  parityRequired: boolean;
  status: DeploymentCheckStatus;
  summary: string;
  checklist: DeploymentChecklistItem[];
  serviceOutcomes: ServiceOutcome[];
  trustBoundaries: TrustBoundary[];
  failureModes: FailureModeDefinition[];
  observability: ObservabilitySignal[];
  nonGoals: string[];
}

function summarizeStatus(status: DeploymentCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'Staging and production critical controls are aligned for this area.';
    case 'warn':
      return 'Core behavior is available, but at least one non-blocking parity gap remains.';
    case 'fail':
      return 'One or more prod-critical controls are missing; clients should not treat this environment as production-like.';
    default:
      return 'Deployment parity checks are informational in development.';
  }
}

function makeCheck(
  key: string,
  title: string,
  status: DeploymentCheckStatus,
  summary: string,
): DeploymentChecklistItem {
  return { key, title, status, summary };
}

export function buildDeploymentChecklistReport(input: {
  config: Config;
  dependencyHealth: HealthReport;
  indexerHealth: IndexerHealth;
}): DeploymentChecklistReport {
  const { config, dependencyHealth, indexerHealth } = input;
  const parityRequired = config.nodeEnv !== 'development';

  const checklist: DeploymentChecklistItem[] = [
    makeCheck(
      'partner_auth',
      'Partner write authentication configured',
      !config.requirePartnerAuth
        ? 'not_applicable'
        : config.partnerApiToken
          ? 'pass'
          : 'fail',
      config.requirePartnerAuth
        ? config.partnerApiToken
          ? 'Partner mutating routes require a bearer token.'
          : 'Partner auth is required but PARTNER_API_TOKEN is missing.'
        : 'Partner auth is disabled in this environment.',
    ),
    makeCheck(
      'admin_auth',
      'Admin diagnostics authentication configured',
      !config.requireAdminAuth
        ? 'not_applicable'
        : config.adminApiToken
          ? 'pass'
          : 'fail',
      config.requireAdminAuth
        ? config.adminApiToken
          ? 'Admin-only health and deployment endpoints require a bearer token.'
          : 'Admin auth is required but ADMIN_API_TOKEN is missing.'
        : 'Admin auth is disabled in this environment.',
    ),
    makeCheck(
      'redis',
      'Redis enabled for prod-like environments',
      !parityRequired
        ? 'not_applicable'
        : config.redisEnabled
          ? 'pass'
          : 'fail',
      config.redisEnabled
        ? 'Redis-backed behavior is enabled.'
        : 'Redis is disabled, so staging does not match production operational assumptions.',
    ),
    makeCheck(
      'workers',
      'Background worker enabled',
      !parityRequired
        ? 'not_applicable'
        : config.workerEnabled
          ? 'pass'
          : 'fail',
      config.workerEnabled
        ? 'Background workers are enabled.'
        : 'Worker processing is disabled, so chain-derived views will not stay production-like.',
    ),
    makeCheck(
      'indexer',
      'Indexer enabled and fresh',
      !config.indexerEnabled
        ? parityRequired
          ? 'fail'
          : 'not_applicable'
        : indexerHealth.status === 'healthy'
          ? 'pass'
          : parityRequired
            ? 'fail'
            : 'warn',
      !config.indexerEnabled ? 'Indexer is disabled.' : indexerHealth.summary,
    ),
    makeCheck(
      'dependencies',
      'Dependency readiness',
      dependencyHealth.status === 'healthy'
        ? 'pass'
        : dependencyHealth.status === 'degraded'
          ? 'warn'
          : 'fail',
      dependencyHealth.status === 'healthy'
        ? 'All registered dependency checks are healthy.'
        : 'One or more dependencies are degraded or unhealthy.',
    ),
    makeCheck(
      'metrics',
      'Metrics and operator observability enabled',
      config.metricsEnabled ? 'pass' : parityRequired ? 'fail' : 'warn',
      config.metricsEnabled
        ? 'Metrics are enabled.'
        : 'Metrics are disabled, reducing production parity for incident response.',
    ),
  ];

  const statuses = checklist.map((item) => item.status);
  const overallStatus: DeploymentCheckStatus =
    statuses.includes('fail')
      ? 'fail'
      : statuses.includes('warn')
        ? 'warn'
        : parityRequired
          ? 'pass'
          : 'not_applicable';

  return {
    environment: config.nodeEnv,
    checklistVersion: config.deploymentChecklistVersion,
    parityRequired,
    status: overallStatus,
    summary: summarizeStatus(overallStatus),
    checklist,
    serviceOutcomes: [
      {
        area: 'HTTP semantics',
        guarantee:
          'Client-visible failures use a normalized JSON error envelope with stable status codes and request IDs.',
      },
      {
        area: 'Chain-derived durability',
        guarantee:
          'When staging/prod indexers are stale or disabled, readiness fails so automation does not trust partial data as durable.',
      },
      {
        area: 'Operator diagnostics',
        guarantee:
          'Health, deployment parity, correlation IDs, and request IDs provide enough context to diagnose incidents without tribal knowledge.',
      },
    ],
    trustBoundaries: [
      {
        actor: 'public_internet_client',
        may: ['Read root metadata', 'Read health summary', 'Read stream listings and stream details'],
        mayNot: ['Create or cancel streams in protected environments', 'Read admin-only diagnostic detail'],
      },
      {
        actor: 'authenticated_partner',
        may: ['Create streams', 'Cancel streams', 'Receive deterministic validation and conflict errors'],
        mayNot: ['Access admin-only deployment diagnostics', 'Bypass validation or idempotency checks'],
      },
      {
        actor: 'administrator',
        may: ['Read detailed health', 'Read deployment parity report', 'Diagnose dependency and indexer failures'],
        mayNot: ['Bypass readiness semantics presented to clients'],
      },
      {
        actor: 'internal_worker',
        may: ['Maintain chain-derived state', 'Advance indexer checkpoints', 'Affect readiness through health status'],
        mayNot: ['Expose unauthenticated HTTP surfaces directly'],
      },
    ],
    failureModes: [
      {
        key: 'invalid_input',
        trigger: 'Missing required fields, malformed decimals, or invalid timestamps.',
        clientVisibleBehavior:
          'HTTP 400 with error.code="validation_error" and field-level details when available.',
        operatorExpectation: 'Use requestId/correlationId to trace the rejection in logs.',
      },
      {
        key: 'dependency_outage',
        trigger: 'Database, Redis, Horizon, or other registered dependency check is unhealthy.',
        clientVisibleBehavior:
          'Readiness returns HTTP 503 and deployment parity degrades or fails.',
        operatorExpectation:
          'Inspect /health/live and dependency summaries to isolate the failing dependency.',
      },
      {
        key: 'partial_data',
        trigger: 'Indexer is disabled, starting, or stalled beyond the freshness threshold.',
        clientVisibleBehavior:
          'Readiness returns HTTP 503 when parity requires fresh chain-derived views.',
        operatorExpectation:
          'Use the indexer section of the health report to confirm freshness and last successful sync time.',
      },
      {
        key: 'duplicate_delivery',
        trigger: 'A partner retries a create request with an already-consumed Idempotency-Key.',
        clientVisibleBehavior:
          'HTTP 409 with error.code="duplicate_delivery" and the original stream ID in details.',
        operatorExpectation:
          'Correlate retries by requestId and Idempotency-Key before replaying or clearing client state.',
      },
    ],
    observability: [
      {
        signal: 'GET /health',
        purpose:
          'Public summary for basic liveness, deployment status, and request correlation headers.',
      },
      {
        signal: 'GET /health/ready',
        purpose: 'Machine-readable readiness gate for staging/prod automation.',
      },
      {
        signal: 'GET /health/live',
        purpose: 'Admin-only dependency and indexer details for incident diagnosis.',
      },
      {
        signal: 'GET /health/deployment',
        purpose: 'Admin-only staging-to-prod checklist parity report.',
      },
      {
        signal: 'Structured logs',
        purpose: 'Every request includes request IDs and correlation IDs for cross-system tracing.',
      },
    ],
    nonGoals: [
      'Persistent stream storage',
      'Real partner or admin identity federation beyond bearer-token gates',
      'Automatic remediation for dependency failures',
    ],
  };
}
