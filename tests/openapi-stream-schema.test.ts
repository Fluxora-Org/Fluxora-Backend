import { test, expect } from 'vitest';
import { buildOpenApiSpec } from '../src/openapi/spec.js';
import { streamSelectColumns } from '../src/db/queries/streams.js';

test('OpenAPI Stream schema keys match DB StreamRecord columns (camelCase mapping)', () => {
  const spec = buildOpenApiSpec();
  const streamSchema = (spec as any)?.components?.schemas?.Stream;
  expect(streamSchema, 'OpenAPI Stream schema missing').toBeDefined();
  const properties = streamSchema.properties ?? {};
  const openApiKeys = Object.keys(properties).sort();

  const csv = streamSelectColumns(1);
  // Split on commas that are not inside parentheses
  const cols = csv
    .split(/,\s*(?![^()]*\))/)
    .map((s) => s.trim())
    .map((frag) => {
      // If expression has an AS alias, use the alias (decrypt_stream_address(...) AS sender_address)
      const m = frag.match(/\s+AS\s+([a-z0-9_]+)/i);
      if (m) return m[1];
      // otherwise assume fragment is a plain column name
      const simple = frag.split(' ').pop() || frag;
      return simple.replace(/"/g, '');
    });

  const dbToApi: Record<string, string> = {
    id: 'id',
    sender_address: 'sender',
    recipient_address: 'recipient',
    amount: 'depositAmount',
    streamed_amount: 'streamedAmount',
    remaining_amount: 'remainingAmount',
    rate_per_second: 'ratePerSecond',
    start_time: 'startTime',
    end_time: 'endTime',
    status: 'status',
    contract_id: 'contractId',
    transaction_hash: 'transactionHash',
    event_index: 'eventIndex',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  };

  const expected = cols.map((c) => dbToApi[c] ?? c.replace(/_([a-z])/g, (_, g) => g.toUpperCase()));
  expected.sort();

  expect(openApiKeys).toEqual(expected);
});
