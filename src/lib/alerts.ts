/**
 * Operator alerting facility.
 *
 * @module lib/alerts
 *
 * ## Why this exists
 *
 * Several background jobs (partition maintenance being the first) can fail in
 * ways that are invisible to the request path: the job fails, the failure is
 * written to a log line, and nothing else happens. Log lines alone are not an
 * alert — they are only actionable if somebody happens to be grepping for
 * them, and they carry no state an on-call rotation can page on.
 *
 * `raiseAlert()` gives those code paths a single, uniform way to say "a human
 * needs to look at this", which is expressed three ways at once:
 *
 *  1. A structured log record at `warn`/`error` level (`event: 'alert'`), so
 *     log-based alerting rules keep working.
 *  2. An increment of the `fluxora_alerts_raised_total{alert,severity}`
 *     Prometheus counter, so metric-based alerting rules can page on it —
 *     including rules that fire when *nothing* is happening, which log lines
 *     cannot express.
 *  3. An optional process-wide sink (see {@link setAlertSink}) so an embedding
 *     application can forward alerts to PagerDuty/Slack/whatever without this
 *     module taking on an outbound HTTP dependency.
 *
 * ## Contract
 *
 * {@link raiseAlert} **never throws**. Alerting is observability: a failure to
 * emit an alert must never be the reason a caller's work fails. Sinks are
 * therefore invoked inside a `try`/`catch`, and the metric increment is
 * guarded the same way.
 *
 * ## Cardinality / security
 *
 * `alert` names come exclusively from developer-controlled call sites in this
 * repository (never from request data), so the counter's label set stays
 * bounded. Any name that is missing or not a plausible identifier is
 * normalised to `unknown_alert` rather than being passed through, so a
 * malformed name can never blow up label cardinality.
 */

import { logger } from './logger.js';
import { alertsRaisedTotal } from '../metrics/businessMetrics.js';

/** Severity of an alert. `critical` pages on-call; `warning` is for a dashboard/ticket. */
export type AlertSeverity = 'warning' | 'critical';

/** A single operator-facing alert. */
export interface AlertEvent {
  /**
   * Stable, machine-readable identifier, e.g. `partition_creation_failed`.
   * Used as the `alert` Prometheus label and the `alert` log field — treat it
   * as an API: renaming one silently breaks alerting rules.
   */
  name: string;
  /** See {@link AlertSeverity}. */
  severity: AlertSeverity;
  /** Human-readable, one-line description shown to an operator. */
  message: string;
  /** Correlation id threaded into the emitted log record, when available. */
  correlationId?: string;
  /** Extra structured fields (e.g. `table`, `partition`). Values are log-sanitised. */
  context?: Record<string, unknown>;
}

/**
 * Consumer of raised alerts. Called synchronously after the log record and
 * metric increment. Implementations must not throw — but if they do, the
 * throw is swallowed (see {@link raiseAlert}).
 */
export type AlertSink = (alert: AlertEvent) => void;

/** Fallback name used when a caller supplies a missing or unusable alert name. */
export const UNKNOWN_ALERT_NAME = 'unknown_alert';

/** Matches the identifier shape accepted as an alert name: `[a-z0-9_.-]{1,64}`. */
const ALERT_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

let alertSink: AlertSink | null = null;

/**
 * Install (or clear) the process-wide alert sink.
 *
 * Pass `null` to remove the current sink. Mainly used by tests and by
 * embedding applications that forward alerts to an incident-management
 * provider.
 */
export function setAlertSink(sink: AlertSink | null): void {
  alertSink = sink;
}

/** Returns the currently installed sink, if any. */
export function getAlertSink(): AlertSink | null {
  return alertSink;
}

/**
 * Normalise an alert name so it can safely be used as a Prometheus label value.
 * Unusable names collapse to {@link UNKNOWN_ALERT_NAME}.
 */
function normalizeAlertName(name: unknown): string {
  return typeof name === 'string' && ALERT_NAME_PATTERN.test(name) ? name : UNKNOWN_ALERT_NAME;
}

/**
 * Raise an operator alert.
 *
 * Emits a structured `warn` (severity `warning`) or `error` (severity
 * `critical`) log record, increments `fluxora_alerts_raised_total{alert,severity}`,
 * and forwards the event to the installed sink.
 *
 * Never throws: this function is safe to call from `catch` blocks and from
 * paths where the original failure must still be re-thrown.
 *
 * @param alert - The alert to raise.
 */
export function raiseAlert(alert: AlertEvent): void {
  const name = normalizeAlertName(alert?.name);
  const severity: AlertSeverity = alert?.severity === 'warning' ? 'warning' : 'critical';
  const message = typeof alert?.message === 'string' && alert.message.length > 0
    ? alert.message
    : `Alert raised: ${name}`;

  try {
    // `context` is spread first so the core alert fields always win and cannot
    // be overwritten by a caller-supplied context key (same rule as logger.write).
    const meta: Record<string, unknown> = {
      ...(alert?.context ?? {}),
      event: 'alert',
      alert: name,
      severity,
    };
    if (severity === 'warning') {
      logger.warn(message, alert?.correlationId, meta);
    } else {
      logger.error(message, alert?.correlationId, meta);
    }
  } catch {
    // Logging must never break the caller.
  }

  try {
    alertsRaisedTotal.inc({ alert: name, severity });
  } catch {
    // Metric registration/collection failures must never break the caller.
  }

  if (alertSink) {
    try {
      alertSink({ ...alert, name, severity, message });
    } catch {
      // A misbehaving sink must never break the caller.
    }
  }
}
