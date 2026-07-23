import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Request, Response } from 'express';
import { TLSSocket } from 'tls';
import { mtlsValidationMiddleware } from '../../src/indexer/mtls.js';
import { getAuditEntries, _resetAuditLog } from '../../src/lib/auditLog.js';
import { indexerMtlsValidationFailuresTotal } from '../../src/metrics/indexerMetrics.js';
import { registry } from '../../src/metrics.js';

describe('mTLS Validation Failure Audit', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetAuditLog();
    indexerMtlsValidationFailuresTotal.reset();

    next = vi.fn();
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    res = {
      status: statusMock,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bypasses mTLS checks if not a TLSSocket', () => {
    req = { socket: {} as any };
    mtlsValidationMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledOnce();
    expect(statusMock).not.toHaveBeenCalled();
    expect(getAuditEntries()).toHaveLength(0);
  });

  it('calls next() if socket is authorized', () => {
    req = {
      socket: {
        authorized: true,
      } as unknown as TLSSocket,
    };
    Object.setPrototypeOf(req.socket, TLSSocket.prototype);

    mtlsValidationMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledOnce();
    expect(statusMock).not.toHaveBeenCalled();
    expect(getAuditEntries()).toHaveLength(0);
  });

  it('audits and rejects with 401 if certificate is missing', async () => {
    const socket = {
      authorized: false,
      authorizationError: null,
      getPeerCertificate: () => null,
    } as unknown as TLSSocket;
    Object.setPrototypeOf(socket, TLSSocket.prototype);

    req = { socket, ip: '127.0.0.1' };
    
    mtlsValidationMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: 'UNAUTHORIZED',
        message: 'mTLS client-certificate validation failed',
      })
    }));

    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'INDEXER_MTLS_FAILURE',
      resourceType: 'indexer_worker',
      resourceId: '127.0.0.1',
      meta: {
        reason: 'missing_cert',
      }
    });

    // Check Prometheus counter
    const metrics = await registry.getMetricsAsJSON();
    const mtlsMetric = metrics.find((m) => m.name === 'indexer_mtls_validation_failures_total');
    expect(mtlsMetric).toBeDefined();
    
    const countData = mtlsMetric?.values.find((v) => v.labels.reason === 'missing_cert');
    expect(countData?.value).toBe(1);
  });

  it('audits and rejects with 403 for expired certificate', async () => {
    const socket = {
      authorized: false,
      authorizationError: new Error('certificate has expired'),
      getPeerCertificate: () => ({
        subject: { CN: 'worker' },
        issuer: { CN: 'ca' },
        serialNumber: '12345',
        // Should not be logged, but simulate a big object
        raw: Buffer.from('fake'),
      }),
    } as unknown as TLSSocket;
    Object.setPrototypeOf(socket, TLSSocket.prototype);

    req = { socket, ip: '192.168.1.10', correlationId: 'req-123' } as unknown as Request;
    
    mtlsValidationMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(403);
    
    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'INDEXER_MTLS_FAILURE',
      resourceId: '192.168.1.10',
      correlationId: 'req-123',
      meta: {
        reason: 'expired',
        subject: { CN: 'worker' },
        issuer: { CN: 'ca' },
        serialNumber: '12345',
        error: 'certificate has expired',
      }
    });
    // Ensure raw buffer is not present
    expect((entries[0].meta as any).raw).toBeUndefined();

    // Check Prometheus counter
    const metrics = await registry.getMetricsAsJSON();
    const mtlsMetric = metrics.find((m) => m.name === 'indexer_mtls_validation_failures_total');
    const countData = mtlsMetric?.values.find((v) => v.labels.reason === 'expired');
    expect(countData?.value).toBe(1);
  });

  it('audits and rejects with 403 for unknown CA', () => {
    const socket = {
      authorized: false,
      authorizationError: new Error('unable to get local issuer certificate'),
      getPeerCertificate: () => ({
        subject: { CN: 'hacker' },
        issuer: { CN: 'hacker-ca' },
        serialNumber: '99999',
      }),
    } as unknown as TLSSocket;
    Object.setPrototypeOf(socket, TLSSocket.prototype);

    req = { socket, ip: '10.0.0.5' } as unknown as Request;
    
    mtlsValidationMiddleware(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(403);
    
    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].meta).toMatchObject({
      reason: 'unknown_ca',
      subject: { CN: 'hacker' },
      issuer: { CN: 'hacker-ca' },
      serialNumber: '99999',
    });
  });
});
