import { Request, Response, NextFunction } from 'express';
import { TLSSocket } from 'tls';
import { recordAuditEvent } from '../lib/auditLog.js';
import { indexerMtlsValidationFailuresTotal } from '../metrics/indexerMetrics.js';

/** Module-level flag set during app initialization. */
let _mtlsRequired = false;

/**
 * Called during app startup to configure strict mTLS enforcement.
 * When `required` is true, non-TLS connections are rejected (fail-closed).
 * Defaults to false (permissive) until explicitly configured.
 */
export function setMtlsRequired(required: boolean): void {
  _mtlsRequired = required;
}

/** Exposed for testing — resets the flag to its default. */
export function _resetMtlsRequiredForTest(): void {
  _mtlsRequired = false;
}

/**
 * Express middleware to validate mutual TLS (mTLS) client certificates
 * on the indexer worker connection.
 *
 * When INDEXER_MTLS_REQUIRED is true (default in production):
 *   - Non-TLS connections are rejected with 403 (fail-closed).
 *   - TLS connections with missing/invalid client certificates are rejected.
 *
 * When INDEXER_MTLS_REQUIRED is false (default in development/staging):
 *   - Non-TLS connections bypass mTLS checks (legacy behaviour for local dev
 *     or reverse-proxy TLS termination).
 *   - TLS connections with missing/invalid client certificates are still
 *     rejected (the cert check is always enforced on TLS connections).
 */
export function mtlsValidationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const socket = req.socket;
  
  if (!(socket instanceof TLSSocket)) {
    if (_mtlsRequired) {
      // Fail closed: a non-TLS connection when mTLS is required means the
      // deployment is misconfigured (e.g. ingress forwarding plain HTTP).
      recordAuditEvent(
        'INDEXER_MTLS_FAILURE',
        'indexer_worker',
        req.ip || 'unknown_ip',
        (req as any).id ?? (req as any).correlationId,
        { reason: 'non_tls_connection_mtls_required' },
      );
      indexerMtlsValidationFailuresTotal.inc({ reason: 'non_tls_mtls_required' });
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'mTLS is required but connection is not TLS',
          requestId: (req as any).id ?? (req as any).correlationId,
        },
      });
      return;
    }
    // If not a TLS socket (e.g. local development or behind a reverse proxy that terminates TLS),
    // we bypass mTLS checks. A real deployment should ensure this route is only accessible
    // via TLS if mTLS is strictly required.
    return next();
  }

  // TLSSocket has `authorized` and `authorizationError` when `requestCert: true` is configured on the server.
  if (socket.authorized) {
    return next();
  }

  // Determine failure reason
  let reason = 'unknown';
  const authError = socket.authorizationError?.message || socket.authorizationError || '';
  const errStr = String(authError).toLowerCase();

  const cert = socket.getPeerCertificate ? socket.getPeerCertificate() : null;
  const isCertMissing = !cert || Object.keys(cert).length === 0;

  if (isCertMissing) {
    reason = 'missing_cert';
  } else if (errStr.includes('expired')) {
    reason = 'expired';
  } else if (errStr.includes('self signed') || errStr.includes('unknown') || errStr.includes('unable to get local issuer certificate')) {
    reason = 'unknown_ca';
  } else if (errStr.trim() !== '') {
    reason = 'invalid_cert';
  } else {
    reason = 'unauthorized';
  }

  // Increment Prometheus counter
  indexerMtlsValidationFailuresTotal.inc({ reason });

  // Record structured audit log
  // IMPORTANT: We do not log raw certificate PEM blobs or private key material,
  // only subject, issuer, and serial number fields.
  const meta: Record<string, unknown> = { reason };

  if (cert && !isCertMissing) {
    meta.subject = cert.subject;
    meta.issuer = cert.issuer;
    meta.serialNumber = cert.serialNumber;
  }
  
  if (authError) {
    meta.error = authError;
  }

  recordAuditEvent(
    'INDEXER_MTLS_FAILURE',
    'indexer_worker',
    req.ip || 'unknown_ip',
    (req as any).id ?? (req as any).correlationId,
    meta
  );

  // Reject the request
  res.status(isCertMissing ? 401 : 403).json({
    error: {
      code: isCertMissing ? 'UNAUTHORIZED' : 'FORBIDDEN',
      message: 'mTLS client-certificate validation failed',
      details: authError || 'Certificate missing or invalid',
      requestId: (req as any).id ?? (req as any).correlationId,
    }
  });
}
