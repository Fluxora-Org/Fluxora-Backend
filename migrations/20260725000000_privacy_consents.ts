/**
 * Migration: Add the `privacy_consents` table.
 *
 * Stores CCPA/BIPA-style recipient consent preferences (analytics_optout,
 * marketing_optout, biometric_processing_consent) keyed on the deterministic
 * HMAC address hash of the Stellar public key (`computeAddressHash`).
 *
 * Plaintext Stellar addresses are never stored or logged in this table.
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('privacy_consents', {
    address_hash: { type: 'text', primaryKey: true },
    analytics_optout: { type: 'boolean', notNull: true, default: false },
    marketing_optout: { type: 'boolean', notNull: true, default: false },
    biometric_processing_consent: { type: 'boolean', notNull: true, default: false },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('privacy_consents');
}
