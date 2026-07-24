import { Request, Response, NextFunction } from 'express';
import { TLSSocket } from 'tls';
import { recordAuditEvent } from '../lib/auditLog.js';
import { indexerMtlsValidationFailuresTotal } from '../metrics/indexerMetrics.js';

/**
 * Express middleware to validate mutual TLS (mTLS) client certificates
 * on the indexer worker connection.
 *
 * If the connection is established over TLS and the client certificate
 * is missing or fails validation, this middleware emits an audit log entry
 * and increments a Prometheus counter before rejecting the request.
 */
export function mtlsValidationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const socket = req.socket;
  
  if (!(socket instanceof TLSSocket)) {
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
