import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvironmentError, loadConfig, resetConfig } from '../../src/config/env.js';

const MIGRATED_VARS = [
  'INDEXER_REPLAY_BATCH_SIZE',
  'INDEXER_MAX_REPLAY_RANGE_BLOCKS',
  'INDEXER_REPLAY_BUDGET_MS',
  'INDEXER_REPLAY_STOP_FORCED_TIMEOUT_MS',
  'DLQ_RETENTION_DAYS',
  'DLQ_PURGE_BATCH_SIZE',
  'PARTITION_MAINTENANCE_LEAD_TIME_MONTHS',
] as const;

describe('migrated config validation (single validated env schema)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfig();
    for (const key of MIGRATED_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetConfig();
    for (const key of MIGRATED_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('preserves all default values identically', () => {
    const cfg = loadConfig();

    expect(cfg.indexerReplayBatchSize).toBe(250);
    expect(cfg.indexerMaxReplayRangeBlocks).toBe(10_000_000);
    expect(cfg.indexerReplayBudgetMs).toBe(0);
    expect(cfg.indexerReplayStopForcedTimeoutMs).toBe(10_000);
    expect(cfg.dlqRetentionDays).toBe(30);
    expect(cfg.dlqPurgeBatchSize).toBe(500);
    expect(cfg.partitionMaintenanceLeadTimeMonths).toBe(3);
  });

  it('accepts valid boundary values', () => {
    process.env.INDEXER_REPLAY_BATCH_SIZE = '1';
    process.env.INDEXER_MAX_REPLAY_RANGE_BLOCKS = '0';
    process.env.INDEXER_REPLAY_BUDGET_MS = '0';
    process.env.INDEXER_REPLAY_STOP_FORCED_TIMEOUT_MS = '0';
    process.env.DLQ_RETENTION_DAYS = '1';
    process.env.DLQ_PURGE_BATCH_SIZE = '5000';
    process.env.PARTITION_MAINTENANCE_LEAD_TIME_MONTHS = '0';

    const cfg = loadConfig();

    expect(cfg.indexerReplayBatchSize).toBe(1);
    expect(cfg.indexerMaxReplayRangeBlocks).toBe(0);
    expect(cfg.indexerReplayBudgetMs).toBe(0);
    expect(cfg.indexerReplayStopForcedTimeoutMs).toBe(0);
    expect(cfg.dlqRetentionDays).toBe(1);
    expect(cfg.dlqPurgeBatchSize).toBe(5000);
    expect(cfg.partitionMaintenanceLeadTimeMonths).toBe(0);
  });

  describe.each(MIGRATED_VARS)('%s rejects non-numeric values with EnvironmentError', (envVar) => {
    it.each(['abc', '10abc', '3.5', 'NaN'])('rejects %j', (badValue) => {
      process.env[envVar] = badValue;
      expect(() => loadConfig()).toThrow(EnvironmentError);
    });
  });

  describe('rejects out-of-range values with EnvironmentError', () => {
    it.each([
      ['INDEXER_REPLAY_BATCH_SIZE', '0'],
      ['INDEXER_REPLAY_BATCH_SIZE', '-5'],
      ['INDEXER_MAX_REPLAY_RANGE_BLOCKS', '-1'],
      ['INDEXER_REPLAY_BUDGET_MS', '-1'],
      ['INDEXER_REPLAY_STOP_FORCED_TIMEOUT_MS', '-1'],
      ['DLQ_RETENTION_DAYS', '0'],
      ['DLQ_RETENTION_DAYS', '-1'],
      ['DLQ_RETENTION_DAYS', '366'],
      ['DLQ_PURGE_BATCH_SIZE', '0'],
      ['DLQ_PURGE_BATCH_SIZE', '-1'],
      ['DLQ_PURGE_BATCH_SIZE', '5001'],
      ['PARTITION_MAINTENANCE_LEAD_TIME_MONTHS', '-1'],
    ])('%s=%s throws EnvironmentError', (envVar, badValue) => {
      process.env[envVar] = badValue;
      expect(() => loadConfig()).toThrow(EnvironmentError);
    });
  });
});
