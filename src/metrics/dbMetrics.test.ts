import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordQuery,
  getDbMetrics,
  resetDbMetrics,
  percentile,
} from './dbMetrics';

describe('dbMetrics', () => {
  beforeEach(() => {
    resetDbMetrics();
  });

  describe('recordQuery', () => {
    it('records a successful query', () => {
      recordQuery('SELECT 1', 10, true);
      const m = getDbMetrics();
      expect(m.totalQueries).toBe(1);
      expect(m.successfulQueries).toBe(1);
      expect(m.failedQueries).toBe(0);
    });

    it('records a failed query', () => {
      recordQuery('SELECT 2', 20, false);
      const m = getDbMetrics();
      exists: {
        expect(m.totalQueries).toBe(1);
        expect(m.successfulQueries).toBe(0);
        expect(m.failedQueries).toBe(1);
      }
    });

    it('accumulates multiple queries', () => {
      recordQuery('SELECT 1', 10, true);
      recordQuery('SELECT 2', 30, true);
      recordQuery('SELECT 3', 50, false);
      const m = getDbMetrics();
      expect(m.totalQueries).toBe(3);
      expect(m.successfulQueries).toBe(2);
      expect(m.failedQueries).toBe(1);
    });

    it('handles zero duration', () => {
      recordQuery('SELECT zero', 0, true);
      const m = getDbMetrics();
      expect(m.totalQueries).toBe(1);
      expect(m.averageDurationMs).toBe(0);
    });

    it('handles maximum safe integer duration', () => {
      const max = Number.MAX_SAFE_INTEGER;
      recordQuery('SELECT max', max, true);
      const m = getDbMetrics();
      expect(m.totalQueries).toBe(1);
      expect(m.maxDurationMs).toBe(max);
    });

    it('tracks max duration across queries', () => {
      recordQuery('SELECT 1', 10, true);
      recordQuery('SELECT 2', 100, true);
      recordQuery('SELECT 3', 50, true);
      const m = getDbMetrics();
      expect(m.maxDurationMs).toBe(100);
    });

    it('computes average duration', () => {
      recordQuery('SELECT 1', 10, true);
      recordQuery('SELECT 2', 20, true);
      recordQuery('SELECT 3', 30, true);
      const m = getDbMetrics();
      expect(m.averageDurationMs).toBe(20);
    });

    it('records last query timestamp as a number', () => {
      recordQuery('SELECT 1', 10, true);
      const m = getDbMetrics();
      expect(typeof m.lastQueryTimestamp).toBe('number');
    });
  });

  describe('getDbMetrics', () => {
    it('returns zero values when nothing recorded', () => {
      const m = getDbMetrics();
      expect(m.totalQueries).toBe(0);
      expect(m.successfulQueries).toBe(0);
      expect(m.failedQueries).toBe(0);
      expect(m.averageDurationMs).toBe(0);
      expect(m.maxDurationMs).toBe(0);
    });

    it('returns a snapshot copy that does not mutate internal state', () => {
      recordQuery('SELECT 1', 10, true);
      const a = getDbMetrics();
      a.totalQueries = 999;
      const b = getDbMetrics();
      expect(b.totalQueries).toBe(1);
    });
  });

  describe('resetDbMetrics', () => {
    it('clears all collected metrics', () => {
      recordQuery('SELECT 1', 10, true);
      resetDbMetrics();
      const m = getDbMetrics();
      expect(m.totalQueries).toBe(0);
      expect(m.successfulQueries).toBe(0);
      expect(m.failedQueries).toBe(0);
    });

    it('is safe to call on empty state', () => {
      expect(() => resetDbMetrics()).not.toThrow();
      expect(getDbMetrics().totalQueries).toBe(0);
    });
  });

  describe('percentile', () => {
    it('returns 0 for an empty array', () => {
      expect(percentile([], 50)).toBe(0);
    });

    it('returns the single value for a one-element array', () => {
      expect(percentile([42], 50)).toBe(42);
      expect(percentile([42], 99)).toBe(42);
    });

    it('returns the minimum for p=0', () => {
      expect(percentile([10, 20, 30], 0)).toBe(10);
    });

    it('returns the maximum for p=100', () => {
      expect(percentile([10, 20, 30], 100)).toBe(30);
    });

    it('computes the median for p=50', () => {
      expect(percentile([10, 20, 30], 50)).toBe(20);
    });

    it('handles unsorted input', () => {
      expect(percentile([30, 10, 20], 50)).toBe(20);
    });

    it('does not mutate the input array', () => {
      const input = [30, 10, 20];
      percentile(input, 50);
      expect(input).toEqual([30, 10, 20]);
    });

    it('clamps out-of-range percentiles', () => {
      expect(percentile([10, 20, 30], -10)).toBe(10);
      expect(percentile([10, 20, 30], 150)).toBe(30);
    });

    it('handles maximum safe integer values', () => {
      const max = Number.MAX_SAFE_INTEGER;
      expect(percentile([max], 50)).toBe(max);
    });
  });
});
