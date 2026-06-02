/**
 * SQL query fragments and helper functions for encrypted stream PII.
 *
 * The `streams` table stores sender/recipient addresses encrypted with pgcrypto.
 * Query helpers in this module keep the encryption/decryption plumbing centralized.
 */

import {
  buildEncryptedAddressFilter,
  pgpDecryptAddressColumn,
  pgpEncryptAddressParam,
} from '../../pii/pgcryptoEncryption.js';

export function streamSelectColumns(
  keyParamIndex: number,
  previousKeyParamIndex?: number,
): string {
  return [
    'id',
    pgpDecryptAddressColumn('sender_address', keyParamIndex, previousKeyParamIndex),
    pgpDecryptAddressColumn('recipient_address', keyParamIndex, previousKeyParamIndex),
    'amount',
    'streamed_amount',
    'remaining_amount',
    'rate_per_second',
    'start_time',
    'end_time',
    'status',
    'contract_id',
    'transaction_hash',
    'event_index',
    'created_at',
    'updated_at',
  ].join(', ');
}

export function encryptAddressValue(addressParamIndex: number, keyParamIndex: number): string {
  return pgpEncryptAddressParam(addressParamIndex, keyParamIndex);
}

export function senderAddressFilterCondition(
  filterValueParamIndex: number,
  senderHashParamIndex: number,
  previousSenderHashParamIndex?: number,
): string {
  return buildEncryptedAddressFilter(
    'sender_address',
    filterValueParamIndex,
    senderHashParamIndex,
    previousSenderHashParamIndex,
  );
}

export function recipientAddressFilterCondition(
  filterValueParamIndex: number,
  recipientHashParamIndex: number,
  previousRecipientHashParamIndex?: number,
): string {
  return buildEncryptedAddressFilter(
    'recipient_address',
    filterValueParamIndex,
    recipientHashParamIndex,
    previousRecipientHashParamIndex,
  );
}
