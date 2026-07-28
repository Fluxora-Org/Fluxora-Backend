import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.addColumns('streams', {
    sender_address_hash: { type: 'text', notNull: true, default: '' },
    recipient_address_hash: { type: 'text', notNull: true, default: '' },
  });

  pgm.createIndex('streams', 'sender_address_hash');
  pgm.createIndex('streams', 'recipient_address_hash');

  pgm.sql(`
    CREATE OR REPLACE FUNCTION decrypt_stream_address(
      value text,
      current_key text,
      previous_key text DEFAULT NULL
    ) RETURNS text AS $$
    DECLARE
      decrypted text;
    BEGIN
      IF value IS NULL THEN
        RETURN NULL;
      END IF;

      IF value LIKE '-----BEGIN PGP MESSAGE-----%' THEN
        BEGIN
          decrypted := pgp_sym_decrypt(value, current_key);
          RETURN decrypted;
        EXCEPTION WHEN others THEN
          IF previous_key IS NOT NULL THEN
            decrypted := pgp_sym_decrypt(value, previous_key);
            RETURN decrypted;
          END IF;
          RAISE;
        END;
      END IF;

      RETURN value;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('streams', 'recipient_address_hash');
  pgm.dropIndex('streams', 'sender_address_hash');
  pgm.dropColumns('streams', ['recipient_address_hash', 'sender_address_hash']);
  pgm.sql('DROP FUNCTION IF EXISTS decrypt_stream_address(text, text, text)');
}
