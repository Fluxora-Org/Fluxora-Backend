/**
 * Structured, PII-safe logger for Fluxora backend.
 *
 * Wraps standard console output with automatic redaction of
 * sensitive fields and Stellar keys. Every log entry is emitted
 * as a single JSON line so downstream aggregators can parse it
 * without custom grammars.
 */

import { sanitize, redactKeysInString } from '../pii/sanitizer.js';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

interface LogEntry {
  level: LogLevel;
  ts: string;
  msg: string;
  [key: string]: unknown;
}

const DUPLICATE_ERROR_WINDOW_MS = 5_000;
const recentErrorFingerprints = new Map<string, number>();

function normalizeFingerprintPart(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function buildErrorFingerprint(message: string, meta?: Record<string, unknown>): string {
  const parts = [
    message,
    normalizeFingerprintPart(meta?.correlationId),
    normalizeFingerprintPart(meta?.requestId),
    normalizeFingerprintPart(meta?.method),
    normalizeFingerprintPart(meta?.path),
    normalizeFingerprintPart(meta?.statusCode),
    normalizeFingerprintPart(meta?.errorCode),
  ];
  return parts.filter((p) => p.length > 0).join('|');
}

function shouldSuppressDuplicateError(message: string, meta?: Record<string, unknown>): boolean {
  const fingerprint = buildErrorFingerprint(message, meta);
  if (!fingerprint) return false;

  const now = Date.now();
  const previous = recentErrorFingerprints.get(fingerprint);
  recentErrorFingerprints.set(fingerprint, now);

  // Opportunistic cleanup while we are touching the map.
  for (const [key, ts] of recentErrorFingerprints.entries()) {
    if (now - ts > DUPLICATE_ERROR_WINDOW_MS) {
      recentErrorFingerprints.delete(key);
    }
  }

  return previous !== undefined && now - previous <= DUPLICATE_ERROR_WINDOW_MS;
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (level === LogLevel.ERROR && shouldSuppressDuplicateError(message, meta)) {
    return;
  }

  const entry: LogEntry = {
    level,
    ts: new Date().toISOString(),
    msg: redactKeysInString(message),
  };

  if (meta) {
    const safe = sanitize(meta);
    for (const [key, value] of Object.entries(safe)) {
      if (key !== 'level' && key !== 'ts' && key !== 'msg') {
        entry[key] = value;
      }
    }
  }

  const line = JSON.stringify(entry);

  switch (level) {
    case LogLevel.ERROR:
      console.error(line);
      break;
    case LogLevel.WARN:
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.DEBUG, message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.INFO, message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.WARN, message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.ERROR, message, meta);
  },
};

export function _resetLoggerForTest(): void {
  recentErrorFingerprints.clear();
}
