/**
 * Unit tests for the operator alerting facility (`src/lib/alerts.ts`).
 *
 * The contract these tests pin down:
 *
 *  - An alert is expressed three ways at once: a structured log record, an
 *    increment of `fluxora_alerts_raised_total{alert,severity}`, and a call to
 *    the installed sink.
 *  - `raiseAlert()` never throws — not on a bad alert name, not when the sink
 *    throws, not when the metric subsystem misbehaves.
 *  - Alert names are normalised so a malformed name can never blow up
 *    Prometheus label cardinality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  raiseAlert,
  setAlertSink,
  getAlertSink,
  UNKNOWN_ALERT_NAME,
  type AlertEvent,
} from '../../src/lib/alerts.js';
import { alertsRaisedTotal } from '../../src/metrics/businessMetrics.js';

/** Captures the JSON log lines written to stderr (levels warn/error). */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('raiseAlert', () => {
  beforeEach(() => {
    setAlertSink(null);
    alertsRaisedTotal.reset();
  });

  afterEach(() => {
    setAlertSink(null);
    vi.restoreAllMocks();
  });

  it('logs a structured error record and increments the counter for a critical alert', () => {
    const stderr = captureStderr();
    const incSpy = vi.spyOn(alertsRaisedTotal, 'inc');

    raiseAlert({
      name: 'partition_creation_failed',
      severity: 'critical',
      message: 'boom',
      correlationId: 'corr-1',
      context: { table: 'contract_events' },
    });

    const record = JSON.parse(
      stderr.lines.find((line) => line.includes('partition_creation_failed'))!,
    );
    expect(record).toMatchObject({
      level: 'error',
      event: 'alert',
      alert: 'partition_creation_failed',
      severity: 'critical',
      table: 'contract_events',
      correlationId: 'corr-1',
      message: 'boom',
    });
    expect(incSpy).toHaveBeenCalledWith({ alert: 'partition_creation_failed', severity: 'critical' });

    stderr.restore();
  });

  it('logs at warn level for a warning-severity alert', () => {
    const stdoutLines: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    raiseAlert({ name: 'cache_stale', severity: 'warning', message: 'stale' });

    const record = JSON.parse(stdoutLines.find((line) => line.includes('cache_stale'))!);
    expect(record.level).toBe('warn');
    expect(record.severity).toBe('warning');
    stdoutSpy.mockRestore();
  });

  it('forwards the alert to the installed sink', () => {
    captureStderr();
    const received: AlertEvent[] = [];
    setAlertSink((alert) => received.push(alert));

    expect(getAlertSink()).not.toBeNull();

    raiseAlert({ name: 'partition_shortfall_detected', severity: 'critical', message: 'missing' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      name: 'partition_shortfall_detected',
      severity: 'critical',
      message: 'missing',
    });
  });

  it('never throws when the sink throws', () => {
    captureStderr();
    setAlertSink(() => {
      throw new Error('sink exploded');
    });

    expect(() => raiseAlert({ name: 'x', severity: 'warning', message: 'm' })).not.toThrow();
  });

  it('normalises an unusable alert name instead of propagating it', () => {
    const stderr = captureStderr();
    const incSpy = vi.spyOn(alertsRaisedTotal, 'inc');

    raiseAlert({ name: 'not a valid name!', severity: 'critical', message: 'm' });
    raiseAlert({ name: '', severity: 'critical', message: 'm' });

    expect(incSpy).toHaveBeenCalledWith({ alert: UNKNOWN_ALERT_NAME, severity: 'critical' });
    expect(stderr.lines.filter((line) => line.includes(UNKNOWN_ALERT_NAME))).toHaveLength(2);
  });

  it('supplies a fallback message and cannot have core fields overridden by context', () => {
    const stderr = captureStderr();

    raiseAlert({
      name: 'sink_down',
      severity: 'critical',
      message: '',
      context: { event: 'spoofed', alert: 'spoofed', severity: 'warning' },
    });

    const record = JSON.parse(stderr.lines.find((line) => line.includes('sink_down'))!);
    expect(record.event).toBe('alert');
    expect(record.alert).toBe('sink_down');
    expect(record.severity).toBe('critical');
    expect(record.message).toBe("Alert raised: sink_down");
  });

  it('clears the sink when set to null', () => {
    setAlertSink(() => undefined);
    setAlertSink(null);
    expect(getAlertSink()).toBeNull();

    captureStderr();
    expect(() => raiseAlert({ name: 'a', severity: 'warning', message: 'm' })).not.toThrow();
  });
});
