/**
 * Tests for webhook secret rotation grace window (Issue #1213).
 *
 * Covers:
 * - verifyWebhookSignature grace window enforcement (bounded acceptance of
 *   the previous secret, explicit rejection after expiry).
 * - webhookSecretRepository persistence of rotation timestamp and grace-window
 *   expiry (setSecret, rotateSecret, clearExpiredPreviousSecret, etc.).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS,
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../../src/webhooks/signature.js';

// ── Mock DB pool for repository tests ─────────────────────────────────────────

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { webhookSecretRepository } from '../../src/db/repositories/webhookSecretRepository.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

const CURRENT_SECRET = 'current-secret-value';
const PREVIOUS_SECRET = 'previous-secret-value';
const TIMESTAMP = '1710000000';
const RAW_BODY = '{"event":"stream.updated"}';

function sign(secret: string, timestamp: string, body: string): string {
  return computeWebhookSignature(secret, timestamp, body);
}

// ── Signature tests ───────────────────────────────────────────────────────────

describe('verifyWebhookSignature — rotation grace window', () => {
  describe('previous secret within grace window', () => {
    it('accepts a signature signed with the previous secret', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 3600, // 1 hour ago
        graceWindowSeconds: 86400, // 24 hours
        deliveryId: 'deliv-grace',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });

    it('accepts a signature signed with the current secret within the grace window', () => {
      const signature = sign(CURRENT_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 3600,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-current',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBeUndefined();
    });

    it('accepts a Date object for now within the grace window', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 3600,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-date-now',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: new Date(1710000000 * 1000),
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });
  });

  describe('previous secret after grace window expiry', () => {
    it('rejects a signature signed with the expired previous secret', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 100000, // ~28 hours ago
        graceWindowSeconds: 86400, // 24 hours
        deliveryId: 'deliv-expired',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('previous_secret_expired');
      expect(result.status).toBe(401);
      expect(result.message).toContain('expired');
    });

    it('still accepts the current secret after the previous secret expired', () => {
      const signature = sign(CURRENT_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 100000,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-current-after-expiry',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBeUndefined();
    });

    it('returns previous_secret_expired when neither secret matches and previous is expired', () => {
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 100000,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-both-fail',
        timestamp: TIMESTAMP,
        signature: 'deadbeef',
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('previous_secret_expired');
    });
  });

  describe('grace window boundary', () => {
    it('accepts the previous secret at the exact grace window boundary', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const rotatedAt = 1710000000 - 86400; // exactly 24 hours ago
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: rotatedAt,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-boundary',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });

    it('rejects the previous secret one second after the grace window boundary', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const rotatedAt = 1710000000 - 86400;
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: rotatedAt,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-after-boundary',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000001,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('previous_secret_expired');
    });
  });

  describe('backward compatibility', () => {
    it('accepts the previous secret when previousSecretRotatedAt is not provided', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        deliveryId: 'deliv-backward-compat',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });

    it('accepts the previous secret when secretPrevious is provided but rotatedAt is undefined', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: undefined,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-undefined-rotated-at',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });
  });

  describe('custom grace window', () => {
    it('respects a custom grace window', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 300, // 5 minutes ago
        graceWindowSeconds: 600, // 10 minutes
        deliveryId: 'deliv-custom-window',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });

    it('rejects the previous secret when outside a custom grace window', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 700, // ~12 minutes ago
        graceWindowSeconds: 600, // 10 minutes
        deliveryId: 'deliv-custom-window-expired',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('previous_secret_expired');
    });
  });

  describe('no previous secret', () => {
    it('only tries the current secret when no previous secret is provided', () => {
      const signature = sign(CURRENT_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        deliveryId: 'deliv-no-previous',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
    });

    it('returns signature_mismatch when only the current secret is tried and it fails', () => {
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        deliveryId: 'deliv-no-previous-fail',
        timestamp: TIMESTAMP,
        signature: 'deadbeef',
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('signature_mismatch');
    });

    it('does not check previous secret when rotatedAt is provided but secretPrevious is absent', () => {
      const signature = sign(CURRENT_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        previousSecretRotatedAt: 1710000000 - 100000,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-rotated-at-no-previous',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('previous secret within window but wrong signature', () => {
    it('returns signature_mismatch when neither secret matches within the grace window', () => {
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 3600,
        graceWindowSeconds: 86400,
        deliveryId: 'deliv-both-fail-in-window',
        timestamp: TIMESTAMP,
        signature: 'deadbeef',
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('signature_mismatch');
    });
  });

  describe('zero grace window', () => {
    it('rejects the previous secret immediately when graceWindowSeconds is 0', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000,
        graceWindowSeconds: 0,
        deliveryId: 'deliv-zero-window',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000001, // 1 second after rotation — outside the 0-second window
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('previous_secret_expired');
    });

    it('accepts the previous secret at the exact rotation moment with a 0-second window', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000,
        graceWindowSeconds: 0,
        deliveryId: 'deliv-zero-window-exact',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000, // exactly at rotation time — elapsed = 0, not > 0
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });
  });

  describe('DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS', () => {
    it('exports a 24-hour default grace window', () => {
      expect(DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS).toBe(86_400);
    });

    it('uses the default when graceWindowSeconds is not specified', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      // 23 hours ago — within the 24-hour default window
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 82800, // 23 hours
        deliveryId: 'deliv-default-window',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(true);
      expect(result.usedPreviousSecret).toBe(true);
    });

    it('rejects the previous secret when outside the default window', () => {
      const signature = sign(PREVIOUS_SECRET, TIMESTAMP, RAW_BODY);
      // 25 hours ago — outside the 24-hour default window
      const result = verifyWebhookSignature({
        secret: CURRENT_SECRET,
        secretPrevious: PREVIOUS_SECRET,
        previousSecretRotatedAt: 1710000000 - 90000, // ~25 hours
        deliveryId: 'deliv-default-window-expired',
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: 1710000000,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('previous_secret_expired');
    });
  });
});

// ── Repository tests ───────────────────────────────────────────────────────────

describe('webhookSecretRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureSchema', () => {
    it('creates the webhook_secrets table and index', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await webhookSecretRepository.ensureSchema();
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const [, sql1] = mockQuery.mock.calls[0]!;
      const [, sql2] = mockQuery.mock.calls[1]!;
      expect(sql1).toContain('CREATE TABLE IF NOT EXISTS webhook_secrets');
      expect(sql1).toContain('current_secret');
      expect(sql1).toContain('previous_secret');
      expect(sql1).toContain('previous_secret_rotated_at');
      expect(sql1).toContain('previous_secret_expires_at');
      expect(sql2).toContain('CREATE INDEX IF NOT EXISTS');
    });
  });

  describe('getSecretState', () => {
    it('returns a mapped state when found', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'curr',
            previous_secret: 'prev',
            previous_secret_rotated_at: 1710000000,
            previous_secret_expires_at: 1710086400,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-02T00:00:00Z'),
          },
        ],
      });
      const state = await webhookSecretRepository.getSecretState('default');
      expect(state).toBeDefined();
      expect(state!.id).toBe('default');
      expect(state!.currentSecret).toBe('curr');
      expect(state!.previousSecret).toBe('prev');
      expect(state!.previousSecretRotatedAt).toBe(1710000000);
      expect(state!.previousSecretExpiresAt).toBe(1710086400);
      expect(state!.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(state!.updatedAt).toBe('2024-01-02T00:00:00.000Z');
    });

    it('returns undefined when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await webhookSecretRepository.getSecretState('missing')).toBeUndefined();
    });

    it('maps null previous_secret fields to null', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'curr',
            previous_secret: null,
            previous_secret_rotated_at: null,
            previous_secret_expires_at: null,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-01T00:00:00Z'),
          },
        ],
      });
      const state = await webhookSecretRepository.getSecretState('default');
      expect(state!.previousSecret).toBeNull();
      expect(state!.previousSecretRotatedAt).toBeNull();
      expect(state!.previousSecretExpiresAt).toBeNull();
    });

    it('maps undefined previous_secret fields to null', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'curr',
            previous_secret: undefined,
            previous_secret_rotated_at: undefined,
            previous_secret_expires_at: undefined,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-01T00:00:00Z'),
          },
        ],
      });
      const state = await webhookSecretRepository.getSecretState('default');
      expect(state!.previousSecret).toBeNull();
      expect(state!.previousSecretRotatedAt).toBeNull();
      expect(state!.previousSecretExpiresAt).toBeNull();
    });

    it('coerces numeric string timestamps to numbers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'curr',
            previous_secret: 'prev',
            previous_secret_rotated_at: '1710000000',
            previous_secret_expires_at: '1710086400',
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-01T00:00:00Z'),
          },
        ],
      });
      const state = await webhookSecretRepository.getSecretState('default');
      expect(state!.previousSecretRotatedAt).toBe(1710000000);
      expect(state!.previousSecretExpiresAt).toBe(1710086400);
    });
  });

  describe('setSecret', () => {
    it('inserts a new secret with no previous secret', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'new-secret',
            previous_secret: null,
            previous_secret_rotated_at: null,
            previous_secret_expires_at: null,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-01T00:00:00Z'),
          },
        ],
      });
      const state = await webhookSecretRepository.setSecret('default', 'new-secret');
      expect(state.currentSecret).toBe('new-secret');
      expect(state.previousSecret).toBeNull();
      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO webhook_secrets');
      expect(params).toEqual(['default', 'new-secret']);
    });
  });

  describe('rotateSecret', () => {
    it('rotates the secret and moves the old one to previous', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'new-secret',
            previous_secret: 'old-secret',
            previous_secret_rotated_at: 1710000000,
            previous_secret_expires_at: 1710086400,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-02T00:00:00Z'),
          },
        ],
      });
      const state = await webhookSecretRepository.rotateSecret('default', {
        newSecret: 'new-secret',
        graceWindowSeconds: 86400,
        rotatedAt: 1710000000,
      });
      expect(state.currentSecret).toBe('new-secret');
      expect(state.previousSecret).toBe('old-secret');
      expect(state.previousSecretRotatedAt).toBe(1710000000);
      expect(state.previousSecretExpiresAt).toBe(1710086400);
      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE webhook_secrets');
      expect(sql).toContain('RETURNING');
      expect(params).toEqual(['default', 'new-secret', 1710000000, 1710086400]);
    });

    it('throws when the id does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(
        webhookSecretRepository.rotateSecret('missing', { newSecret: 'new' }),
      ).rejects.toThrow('Cannot rotate secret: no row with id "missing"');
    });

    it('uses default grace window when not specified', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'new',
            previous_secret: 'old',
            previous_secret_rotated_at: 1710000000,
            previous_secret_expires_at: 1710086400,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-02T00:00:00Z'),
          },
        ],
      });
      await webhookSecretRepository.rotateSecret('default', {
        newSecret: 'new',
        rotatedAt: 1710000000,
      });
      const [, , params] = mockQuery.mock.calls[0]!;
      expect(params[3]).toBe(1710000000 + 86400);
    });

    it('uses current time when rotatedAt is not specified', async () => {
      const realNow = Date.now;
      Date.now = vi.fn(() => 1710000000000); // 1710000000 seconds
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'default',
            current_secret: 'new',
            previous_secret: 'old',
            previous_secret_rotated_at: 1710000000,
            previous_secret_expires_at: 1710086400,
            created_at: new Date('2024-01-01T00:00:00Z'),
            updated_at: new Date('2024-01-02T00:00:00Z'),
          },
        ],
      });
      await webhookSecretRepository.rotateSecret('default', {
        newSecret: 'new',
        graceWindowSeconds: 86400,
      });
      const [, , params] = mockQuery.mock.calls[0]!;
      expect(params[2]).toBe(1710000000);
      expect(params[3]).toBe(1710000000 + 86400);
      Date.now = realNow;
    });
  });

  describe('clearExpiredPreviousSecret', () => {
    it('clears the previous secret when the grace window has expired', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const cleared = await webhookSecretRepository.clearExpiredPreviousSecret(
        'default',
        1710086401,
      );
      expect(cleared).toBe(true);
      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE webhook_secrets');
      expect(sql).toContain('previous_secret = NULL');
      expect(params).toEqual(['default', 1710086401]);
    });

    it('does not clear when the grace window has not expired', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const cleared = await webhookSecretRepository.clearExpiredPreviousSecret(
        'default',
        1710000000,
      );
      expect(cleared).toBe(false);
    });

    it('does not clear when previous_secret is already null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const cleared = await webhookSecretRepository.clearExpiredPreviousSecret(
        'default',
        1710086401,
      );
      expect(cleared).toBe(false);
    });

    it('uses current time when now is not specified', async () => {
      const realNow = Date.now;
      Date.now = vi.fn(() => 1710086401000); // 1710086401 seconds
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const cleared = await webhookSecretRepository.clearExpiredPreviousSecret('default');
      expect(cleared).toBe(true);
      const [, , params] = mockQuery.mock.calls[0]!;
      expect(params[1]).toBe(1710086401);
      Date.now = realNow;
    });
  });

  describe('deleteSecretState', () => {
    it('deletes the row and returns true', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const deleted = await webhookSecretRepository.deleteSecretState('default');
      expect(deleted).toBe(true);
      const [, sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('DELETE FROM webhook_secrets');
      expect(params).toEqual(['default']);
    });

    it('returns false when no row was deleted', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const deleted = await webhookSecretRepository.deleteSecretState('missing');
      expect(deleted).toBe(false);
    });
  });
});
