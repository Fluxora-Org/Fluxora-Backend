import { describe, it, expect } from 'vitest';
import {
  DataClassification,
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  redactableFields,
} from '../../src/pii/policy.js';

describe('PII policy definitions', () => {
  describe('STREAM_FIELD_POLICIES', () => {
    it('classifies sender and recipient as SENSITIVE', () => {
      expect(STREAM_FIELD_POLICIES.sender.classification).toBe(DataClassification.SENSITIVE);
      expect(STREAM_FIELD_POLICIES.recipient.classification).toBe(DataClassification.SENSITIVE);
    });

    it('marks sender and recipient for log redaction', () => {
      expect(STREAM_FIELD_POLICIES.sender.redactInLogs).toBe(true);
      expect(STREAM_FIELD_POLICIES.recipient.redactInLogs).toBe(true);
    });

    it('does not redact public or internal fields', () => {
      expect(STREAM_FIELD_POLICIES.id.redactInLogs).toBe(false);
      expect(STREAM_FIELD_POLICIES.depositAmount.redactInLogs).toBe(false);
      expect(STREAM_FIELD_POLICIES.startTime.redactInLogs).toBe(false);
      expect(STREAM_FIELD_POLICIES.status.redactInLogs).toBe(false);
    });

    it('covers all expected stream fields', () => {
      const expected = ['id', 'sender', 'recipient', 'depositAmount', 'ratePerSecond', 'startTime', 'status'];
      expect(Object.keys(STREAM_FIELD_POLICIES).sort()).toEqual(expected.sort());
    });

    it('every policy has a non-empty rationale', () => {
      for (const [field, policy] of Object.entries(STREAM_FIELD_POLICIES)) {
        expect(policy.rationale.length, `${field} rationale is empty`).toBeGreaterThan(0);
      }
    });
  });

  describe('REQUEST_FIELD_POLICIES', () => {
    it('classifies IP address and auth token as RESTRICTED', () => {
      expect(REQUEST_FIELD_POLICIES.ipAddress.classification).toBe(DataClassification.RESTRICTED);
      expect(REQUEST_FIELD_POLICIES.authToken.classification).toBe(DataClassification.RESTRICTED);
    });

    it('marks all request fields for redaction', () => {
      for (const policy of Object.values(REQUEST_FIELD_POLICIES)) {
        expect(policy.redactInLogs).toBe(true);
      }
    });
  });

  describe('RETENTION_SCHEDULE', () => {
    it('has at least one rule', () => {
      expect(RETENTION_SCHEDULE.length).toBeGreaterThan(0);
    });

    it('HTTP request metadata has zero retention days', () => {
      const httpRule = RETENTION_SCHEDULE.find((r) => r.category.includes('HTTP'));
      expect(httpRule).toBeDefined();
      expect(httpRule!.retentionDays).toBe(0);
    });

    it('chain-derived data has null (indefinite) retention', () => {
      const chainRule = RETENTION_SCHEDULE.find((r) => r.category.includes('chain-derived'));
      expect(chainRule).toBeDefined();
      expect(chainRule!.retentionDays).toBeNull();
    });

    it('authentication tokens are not persisted', () => {
      const tokenRule = RETENTION_SCHEDULE.find((r) => r.category.includes('Authentication'));
      expect(tokenRule).toBeDefined();
      expect(tokenRule!.retentionDays).toBe(0);
    });

    it('every rule has a rationale', () => {
      for (const rule of RETENTION_SCHEDULE) {
        expect(rule.rationale.length).toBeGreaterThan(0);
      }
    });
  });

  describe('TRUST_BOUNDARIES', () => {
    it('defines four actor classes', () => {
      const actors = TRUST_BOUNDARIES.map((b) => b.actor);
      expect(actors).toContain('Anonymous client');
      expect(actors).toContain('Authenticated partner');
      expect(actors).toContain('Administrator');
      expect(actors).toContain('Internal worker');
    });

    it('every boundary has at least one allowed and one denied action', () => {
      for (const boundary of TRUST_BOUNDARIES) {
        expect(boundary.allowed.length, `${boundary.actor} allowed`).toBeGreaterThan(0);
        expect(boundary.denied.length, `${boundary.actor} denied`).toBeGreaterThan(0);
      }
    });

    it('anonymous clients cannot create streams', () => {
      const anon = TRUST_BOUNDARIES.find((b) => b.actor === 'Anonymous client')!;
      const deniedText = anon.denied.join(' ');
      expect(deniedText.toLowerCase()).toContain('create');
    });
  });

  describe('redactableFields()', () => {
    it('includes sender and recipient', () => {
      const fields = redactableFields();
      expect(fields.has('sender')).toBe(true);
      expect(fields.has('recipient')).toBe(true);
    });

    it('includes request metadata fields', () => {
      const fields = redactableFields();
      expect(fields.has('ipAddress')).toBe(true);
      expect(fields.has('authToken')).toBe(true);
      expect(fields.has('userAgent')).toBe(true);
    });

    it('does not include public fields', () => {
      const fields = redactableFields();
      expect(fields.has('id')).toBe(false);
      expect(fields.has('status')).toBe(false);
      expect(fields.has('startTime')).toBe(false);
    });
  });
});
