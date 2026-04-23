/**
 * Privacy policy endpoints.
 *
 * Exposes the PII policy, data classification schema, retention
 * schedule, and trust boundaries as machine-readable JSON so that
 * integrators and auditors can inspect what the service stores
 * without reading source code.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  DataClassification,
} from '../pii/policy.js';

export const privacyRouter = Router();

const SERVICE_NAME = 'fluxora-backend';
const SERVICE_VERSION = '0.1.0';

/**
 * Middleware: set security and cache headers on every privacy response.
 *
 * Policy documents must not be cached by intermediaries — an operator
 * updating the policy should see the change immediately.
 */
function privacyHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

privacyRouter.use(privacyHeaders);

/**
 * Reject HTTP methods other than GET and HEAD on all privacy routes.
 * HEAD is implicitly handled by Express for GET routes.
 */
function rejectUnsupportedMethods(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `${req.method} is not allowed on this resource`,
      },
    });
    return;
  }
  next();
}

privacyRouter.use(rejectUnsupportedMethods);

/**
 * GET /api/privacy/policy
 *
 * Returns the full PII policy document: field classifications,
 * retention schedule, and trust boundaries.
 */
privacyRouter.get('/policy', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    piiPolicy: {
      summary:
        'Fluxora stores only chain-derived pseudonymous data (Stellar public keys and ' +
        'on-chain amounts). No direct PII such as names, emails, or physical addresses ' +
        'is collected. HTTP request metadata (IP, user-agent) is ephemeral and never persisted.',
      dataClassifications: Object.values(DataClassification).map((level) => ({
        level,
        description: classificationDescription(level),
      })),
      fieldPolicies: {
        streamFields: STREAM_FIELD_POLICIES,
        requestFields: REQUEST_FIELD_POLICIES,
      },
      retentionSchedule: RETENTION_SCHEDULE,
      trustBoundaries: TRUST_BOUNDARIES,
    },
    _links: {
      self: '/api/privacy/policy',
      retention: '/api/privacy/retention',
      health: '/health',
      streams: '/api/streams',
    },
  });
});

/**
 * GET /api/privacy/retention
 *
 * Lightweight view of just the retention schedule for quick
 * compliance checks.
 */
privacyRouter.get('/retention', (_req: Request, res: Response) => {
  res.json({
    retentionSchedule: RETENTION_SCHEDULE,
    _links: {
      self: '/api/privacy/retention',
      fullPolicy: '/api/privacy/policy',
    },
  });
});

/** Map a classification enum value to a human-readable description. */
function classificationDescription(level: DataClassification): string {
  switch (level) {
    case DataClassification.PUBLIC:
      return 'Freely shareable; no privacy implications.';
    case DataClassification.INTERNAL:
      return 'Operational data visible to authenticated users and operators.';
    case DataClassification.SENSITIVE:
      return 'Pseudonymous identifiers that could be correlated to real identities. Redacted in logs.';
    case DataClassification.RESTRICTED:
      return 'Credentials or direct PII. Never persisted, never logged.';
  }
}
