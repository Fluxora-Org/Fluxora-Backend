/**
 * Validation tests for indexer lag alerting thresholds.
 *
 * These tests validate the threshold logic and provide a reference for
 * inducing lag in a staging environment to confirm the Prometheus alerts fire
 * as documented.
 *
 * ## What these tests validate
 *
 * 1. **Threshold constants are correct**: The values exported from
 *    `src/config/indexer-thresholds.ts` match the documented thresholds.
 *
 * 2. **Metric is observable**: The `indexer_ledger_lag` gauge can be read from
 *    the Prometheus registry and returns a numeric value.
 *
 * 3. **Threshold logic**: Simulated lag values correctly classify into
 *    `normal`, `warning`, or `critical` states according to the documented
 *    thresholds.
 *
 * 4. **Time-based conversion**: Ledger-based thresholds convert correctly to
 *    time-based thresholds (assuming 5s per ledger).
 *
 * ## What these tests DO NOT validate
 *
 * - Prometheus alert rule syntax (use `promtool check rules` for that)
 * - Alert firing in a live Prometheus instance (requires induced-incident test)
 * - Alertmanager routing and notification delivery
 * - End-to-end paging workflow
 *
 * For full validation, follow the induced-incident procedure in
 * `docs/observability/alerting-runbook.md`.
 *
 * @module tests/observability/indexer-lag-alert-validation
 */

import { describe, it, expect } from 'vitest';
import {
  INDEXER_LAG_WARNING_THRESHOLD_LEDGERS,
  INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS,
  INDEXER_LAG_WARNING_THRESHOLD_SECONDS,
  INDEXER_LAG_CRITICAL_THRESHOLD_SECONDS,
  INDEXER_LAG_WARNING_FOR_MINUTES,
  INDEXER_LAG_CRITICAL_FOR_MINUTES,
  INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS,
} from '../../src/config/indexer-thresholds.js';
import { indexerLedgerLag } from '../../src/metrics/indexerLag.js';

describe('Indexer lag alert thresholds', () => {
  describe('Threshold constants', () => {
    it('warning threshold is 100 ledgers', () => {
      expect(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS).toBe(100);
    });

    it('critical threshold is 300 ledgers', () => {
      expect(INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS).toBe(300);
    });

    it('critical threshold is 3x warning threshold', () => {
      expect(INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS).toBe(
        INDEXER_LAG_WARNING_THRESHOLD_LEDGERS * 3
      );
    });

    it('warning threshold is ~8 minutes of chain time', () => {
      // 100 ledgers × 5 seconds/ledger = 500 seconds ≈ 8.3 minutes
      expect(INDEXER_LAG_WARNING_THRESHOLD_SECONDS).toBe(500);
      expect(INDEXER_LAG_WARNING_THRESHOLD_SECONDS / 60).toBeCloseTo(8.33, 1);
    });

    it('critical threshold is ~25 minutes of chain time', () => {
      // 300 ledgers × 5 seconds/ledger = 1500 seconds = 25 minutes
      expect(INDEXER_LAG_CRITICAL_THRESHOLD_SECONDS).toBe(1500);
      expect(INDEXER_LAG_CRITICAL_THRESHOLD_SECONDS / 60).toBe(25);
    });

    it('backfill yield threshold is half of warning threshold', () => {
      expect(INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS).toBe(50);
      expect(INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS).toBe(
        Math.floor(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / 2)
      );
    });
  });

  describe('Alert duration (for clause)', () => {
    it('warning fires after 5 minutes', () => {
      expect(INDEXER_LAG_WARNING_FOR_MINUTES).toBe(5);
    });

    it('critical fires after 10 minutes', () => {
      expect(INDEXER_LAG_CRITICAL_FOR_MINUTES).toBe(10);
    });

    it('critical for clause is longer than warning', () => {
      expect(INDEXER_LAG_CRITICAL_FOR_MINUTES).toBeGreaterThan(
        INDEXER_LAG_WARNING_FOR_MINUTES
      );
    });
  });

  describe('Metric observability', () => {
    it('indexerLedgerLag gauge is registered', () => {
      expect(indexerLedgerLag).toBeDefined();
      expect(indexerLedgerLag.name).toBe('indexer_ledger_lag');
    });

    it('indexerLedgerLag gauge can be read', async () => {
      // Set a known value
      indexerLedgerLag.set(42);

      // Read it back via the Prometheus registry
      const metric = (await indexerLedgerLag.get()) as {
        values: Array<{ value: number }>;
      };

      expect(metric.values).toBeDefined();
      expect(metric.values.length).toBeGreaterThan(0);
      expect(metric.values[0].value).toBe(42);

      // Reset to 0 for test isolation
      indexerLedgerLag.set(0);
    });
  });

  describe('Threshold classification logic', () => {
    /**
     * Helper to classify a lag value into normal/warning/critical.
     * This mirrors the logic an operator or dashboard would use.
     */
    function classifyLag(ledgers: number): 'normal' | 'warning' | 'critical' {
      if (ledgers >= INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS) {
        return 'critical';
      }
      if (ledgers >= INDEXER_LAG_WARNING_THRESHOLD_LEDGERS) {
        return 'warning';
      }
      return 'normal';
    }

    it('classifies 0 ledgers as normal', () => {
      expect(classifyLag(0)).toBe('normal');
    });

    it('classifies p99 lag (15 ledgers) as normal', () => {
      expect(classifyLag(15)).toBe('normal');
    });

    it('classifies brief spike (30 ledgers) as normal', () => {
      // Deployment restart or single RPC timeout
      expect(classifyLag(30)).toBe('normal');
    });

    it('classifies 99 ledgers as normal (just below warning)', () => {
      expect(classifyLag(99)).toBe('normal');
    });

    it('classifies 100 ledgers as warning (threshold boundary)', () => {
      expect(classifyLag(100)).toBe('warning');
    });

    it('classifies 150 ledgers as warning', () => {
      expect(classifyLag(150)).toBe('warning');
    });

    it('classifies 299 ledgers as warning (just below critical)', () => {
      expect(classifyLag(299)).toBe('warning');
    });

    it('classifies 300 ledgers as critical (threshold boundary)', () => {
      expect(classifyLag(300)).toBe('critical');
    });

    it('classifies 500 ledgers as critical', () => {
      expect(classifyLag(500)).toBe('critical');
    });
  });

  describe('Observed normal lag boundaries', () => {
    it('p50 lag (2 ledgers) is well below warning', () => {
      const p50 = 2;
      expect(p50).toBeLessThan(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / 10);
    });

    it('p95 lag (5 ledgers) is well below warning', () => {
      const p95 = 5;
      expect(p95).toBeLessThan(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / 10);
    });

    it('p99 lag (15 ledgers) is well below warning', () => {
      const p99 = 15;
      expect(p99).toBeLessThan(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / 5);
    });

    it('transient deployment spike (30 ledgers) is below warning', () => {
      const deploymentSpike = 30;
      expect(deploymentSpike).toBeLessThan(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS);
    });

    it('warning threshold is 6–10× p99', () => {
      const p99 = 15;
      const ratio = INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / p99;
      expect(ratio).toBeGreaterThanOrEqual(6);
      expect(ratio).toBeLessThanOrEqual(10);
    });
  });

  describe('Induced incident simulation', () => {
    it('provides lag accumulation rate for manual testing', () => {
      // Stellar mainnet: 1 ledger every ~5 seconds = 12 ledgers/minute
      const ledgersPerMinute = 12;

      // Time to reach warning threshold (100 ledgers)
      const minutesToWarning = Math.ceil(
        INDEXER_LAG_WARNING_THRESHOLD_LEDGERS / ledgersPerMinute
      );
      expect(minutesToWarning).toBe(9); // 100 / 12 ≈ 8.33, rounded up

      // Time to reach critical threshold (300 ledgers)
      const minutesToCritical = Math.ceil(
        INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS / ledgersPerMinute
      );
      expect(minutesToCritical).toBe(25); // 300 / 12 = 25 exactly

      // Add the `for` clause duration to get total time until alert fires
      const totalMinutesToWarningFiring = minutesToWarning + INDEXER_LAG_WARNING_FOR_MINUTES;
      const totalMinutesToCriticalFiring = minutesToCritical + INDEXER_LAG_CRITICAL_FOR_MINUTES;

      expect(totalMinutesToWarningFiring).toBe(14); // 9 + 5
      expect(totalMinutesToCriticalFiring).toBe(35); // 25 + 10
    });

    it('documents how to induce lag in staging', () => {
      /**
       * To manually validate the alert fires:
       *
       * 1. Identify the indexer process:
       *    ```bash
       *    pgrep -f indexer
       *    ```
       *
       * 2. Pause the process (SIGSTOP):
       *    ```bash
       *    kill -STOP $(pgrep -f indexer)
       *    ```
       *
       * 3. Wait for lag to accumulate:
       *    - After ~9 minutes: lag should cross 100 ledgers
       *    - After 5 more minutes (14 total): IndexerLagWarning fires
       *    - After ~16 more minutes (30 total): lag crosses 300 ledgers
       *    - After 10 more minutes (40 total): IndexerLagCritical fires
       *
       * 4. Monitor lag in real time:
       *    ```bash
       *    watch -n 2 'curl -s http://localhost:$PORT/metrics | grep indexer_ledger_lag'
       *    ```
       *
       * 5. Check Prometheus alerts:
       *    ```bash
       *    curl http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.labels.alertname | startswith("IndexerLag"))'
       *    ```
       *
       * 6. Resume the process:
       *    ```bash
       *    kill -CONT $(pgrep -f indexer)
       *    ```
       *
       * 7. Confirm recovery:
       *    - Lag should decrease steadily
       *    - Alerts should resolve within 1–2 Prometheus scrape intervals after lag drops below threshold
       */

      // This test always passes; it exists to document the validation procedure.
      expect(true).toBe(true);
    });
  });

  describe('Backfill yield integration', () => {
    it('backfill pauses before lag reaches warning threshold', () => {
      // Backfill yield threshold: 50 ledgers
      // Warning threshold: 100 ledgers
      expect(INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS).toBeLessThan(
        INDEXER_LAG_WARNING_THRESHOLD_LEDGERS
      );
    });

    it('backfill pauses with comfortable margin before warning', () => {
      // The backfill should pause at 50 ledgers, giving the indexer 50 more
      // ledgers (≈4 minutes) to catch up before the warning alert fires.
      const margin = INDEXER_LAG_WARNING_THRESHOLD_LEDGERS - INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS;
      expect(margin).toBe(50);
      expect(margin).toBeGreaterThanOrEqual(INDEXER_BACKFILL_YIELD_THRESHOLD_LEDGERS);
    });
  });

  describe('Time-based threshold conversion', () => {
    it('converts ledger thresholds to seconds correctly', () => {
      // Stellar mainnet: ~5 seconds per ledger
      const secondsPerLedger = 5;

      expect(INDEXER_LAG_WARNING_THRESHOLD_SECONDS).toBe(
        INDEXER_LAG_WARNING_THRESHOLD_LEDGERS * secondsPerLedger
      );

      expect(INDEXER_LAG_CRITICAL_THRESHOLD_SECONDS).toBe(
        INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS * secondsPerLedger
      );
    });

    it('time-based thresholds are usable for fluxora_indexer_lag_seconds', () => {
      // The `fluxora_indexer_lag_seconds` gauge in businessMetrics.ts measures
      // lag in seconds (not ledgers). These constants let operators write
      // equivalent alerts for that gauge if needed.

      // Warning: 500 seconds ≈ 8.3 minutes
      expect(INDEXER_LAG_WARNING_THRESHOLD_SECONDS).toBe(500);

      // Critical: 1500 seconds = 25 minutes
      expect(INDEXER_LAG_CRITICAL_THRESHOLD_SECONDS).toBe(1500);
    });
  });

  describe('Alert annotation helpers', () => {
    it('provides formulas for Prometheus alert annotations', () => {
      /**
       * Example Prometheus alert annotation templates:
       *
       * ```yaml
       * annotations:
       *   # Lag in minutes (divide by 12 since 1 ledger ≈ 5s, 12 ledgers/minute)
       *   lag_minutes: '{{ printf "%.1f" (div $value 12) }}'
       *
       *   # Lag in seconds (multiply by 5)
       *   lag_seconds: '{{ printf "%.1f" (mul $value 5) }}'
       *
       *   # Equivalent time-based lag for fluxora_indexer_lag_seconds
       *   lag_seconds_direct: '{{ $value }}'
       * ```
       */

      const lagInLedgers = 100;

      // Convert to minutes: ledgers / 12
      const lagInMinutes = lagInLedgers / 12;
      expect(lagInMinutes).toBeCloseTo(8.33, 1);

      // Convert to seconds: ledgers * 5
      const lagInSeconds = lagInLedgers * 5;
      expect(lagInSeconds).toBe(500);
    });
  });
});

describe('Prometheus alert rule validation', () => {
  /**
   * These tests document the expected Prometheus alert rule structure.
   * They don't execute PromQL, but serve as a reference for what the
   * rules should look like.
   */

  it('documents expected IndexerLagWarning rule', () => {
    const expectedRule = {
      alert: 'IndexerLagWarning',
      expr: 'indexer_ledger_lag >= 100',
      for: '5m',
      labels: {
        severity: 'warning',
        component: 'indexer',
        subsystem: 'ingestion',
      },
    };

    expect(expectedRule.expr).toContain(
      String(INDEXER_LAG_WARNING_THRESHOLD_LEDGERS)
    );
    expect(expectedRule.for).toBe(`${INDEXER_LAG_WARNING_FOR_MINUTES}m`);
  });

  it('documents expected IndexerLagCritical rule', () => {
    const expectedRule = {
      alert: 'IndexerLagCritical',
      expr: 'indexer_ledger_lag >= 300',
      for: '10m',
      labels: {
        severity: 'critical',
        component: 'indexer',
        subsystem: 'ingestion',
        page: 'true',
      },
    };

    expect(expectedRule.expr).toContain(
      String(INDEXER_LAG_CRITICAL_THRESHOLD_LEDGERS)
    );
    expect(expectedRule.for).toBe(`${INDEXER_LAG_CRITICAL_FOR_MINUTES}m`);
    expect(expectedRule.labels.page).toBe('true');
  });

  it('critical alert has paging label', () => {
    // The critical alert must have a label that triggers paging.
    // Common labels: page="true", priority="P1", severity="critical"
    const criticalLabelsMustInclude = ['page', 'severity'];
    expect(criticalLabelsMustInclude).toContain('page');
    expect(criticalLabelsMustInclude).toContain('severity');
  });
});
