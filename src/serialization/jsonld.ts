import { StreamRecord } from '../db/types.js';
import { serializeToDecimalString } from './decimal.js';

export const FLUXORA_JSONLD_CONTEXT = 'https://fluxora.dev/ns/v1';

export function toStreamJsonLd(record: StreamRecord) {
  return {
    '@context': FLUXORA_JSONLD_CONTEXT,
    '@type': 'PaymentStream',
    identifier: record.id,
    sender: record.sender_address,
    recipient: record.recipient_address,
    depositAmount: serializeToDecimalString(record.amount, 'depositAmount'),
    streamedAmount: serializeToDecimalString(record.streamed_amount, 'streamedAmount'),
    remainingAmount: serializeToDecimalString(record.remaining_amount, 'remainingAmount'),
    ratePerSecond: serializeToDecimalString(record.rate_per_second, 'ratePerSecond'),
    startTime: record.start_time,
    endTime: record.end_time,
    status: record.status,
  };
}
