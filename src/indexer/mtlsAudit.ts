import { PeerCertificate } from 'tls';
import { recordAuditEvent } from '../lib/auditLog.js';
// We don't have a direct prometheus counter imported yet, but we will mock or implement one here if necessary.
import * as metrics from '../metrics/index.js';

export type MtlsFailureReason = 'EXPIRED_CERT' | 'UNKNOWN_CA' | 'INVALID_SUBJECT' | 'NO_CERTIFICATE' | 'OTHER';

/**
 * Parses the Node.js TLS authorizationError to a structured reason.
 */
function parseAuthorizationError(authError: string | undefined): MtlsFailureReason {
  if (!authError) return 'NO_CERTIFICATE';
  const lowerErr = authError.toLowerCase();
  if (lowerErr.includes('expired')) return 'EXPIRED_CERT';
  if (lowerErr.includes('unknown ca') || lowerErr.includes('self signed') || lowerErr.includes('unable to get local issuer')) return 'UNKNOWN_CA';
  if (lowerErr.includes('subject') || lowerErr.includes('hostname')) return 'INVALID_SUBJECT';
  return 'OTHER';
}

/**
 * Logs an audit event and increments a metric when mTLS client certificate validation fails.
 * 
 * @param authError The authorizationError string from the TLS socket.
 * @param cert The peer certificate object, if available. Note: Private keys are NEVER logged.
 * @param connectionId An optional correlation ID for the connection.
 */
export function logMtlsValidationFailure(
  authError: string | undefined,
  cert: PeerCertificate | null,
  connectionId?: string
): void {
  const reason = parseAuthorizationError(authError);
  
  // The metrics module exposes no generic `increment`; the call was written
  // speculatively and guarded. Keep the guard, but look the symbol up in a way
  // that type-checks against the module's actual surface.
  const increment = (
    metrics as unknown as {
      increment?: (name: string, value: number, labels?: Record<string, string>) => void;
    }
  ).increment;
  if (typeof increment === 'function') {
    increment('indexer_mtls_validation_failures_total', 1, { reason });
  }

  // Extract safe certificate fields
  const safeCertDetails: Record<string, unknown> = { reason, authError };
  if (cert && Object.keys(cert).length > 0) {
    safeCertDetails.subject = cert.subject;
    safeCertDetails.issuer = cert.issuer;
    safeCertDetails.serialNumber = cert.serialNumber;
    safeCertDetails.valid_from = cert.valid_from;
    safeCertDetails.valid_to = cert.valid_to;
    safeCertDetails.fingerprint256 = cert.fingerprint256;
  }

  recordAuditEvent(
    'MTLS_VALIDATION_FAILED',
    'indexer_connection',
    connectionId || 'unknown_connection',
    connectionId,
    safeCertDetails
  );
}
