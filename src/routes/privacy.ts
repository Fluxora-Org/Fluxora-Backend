/**
 * Privacy policy endpoints.
 *
 * Exposes the PII policy, data classification schema, retention
 * schedule, and trust boundaries as machine-readable JSON so that
 * integrators and auditors can inspect what the service stores
 * without reading source code.
 */

import { Router } from 'express';
import {
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  DataClassification,
} from '../pii/policy.js';

export const privacyRouter = Router();

/**
 * GET /api/privacy/policy
 *
 * Returns the full PII policy document: field classifications,
 * retention schedule, and trust boundaries.
 */
privacyRouter.get('/policy', (_req, res) => {
  res.json({
    service: 'fluxora-backend',
    version: '0.1.0',
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
privacyRouter.get('/retention', (_req, res) => {
  res.json({
    retentionSchedule: RETENTION_SCHEDULE,
  });
});

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
