import { describe, test, expect } from 'vitest';
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

describe('OpenAPI contract-events query params parity', () => {
  /**
   * Query param names accepted by the actual /internal/indexer/events route
   * (see src/routes/indexer.ts:140-158). These must match the OpenAPI spec params
   * so clients can discover ledger-range filtering and pagination from docs.
   */
  const eventsRequiredParams = ['fromLedger', 'toledger', 'contractId', 'topic', 'limit', 'offset'];

  /**
   * Query param names accepted by the /internal/indexer/events/replay route
   * (see src/routes/indexer.ts:105-136).
   */
  const replayRequiredParams = ['afterEventId', 'fromLedger', 'toledger', 'contractId', 'topic', 'limit'];

  function paramsForPath(spec: Record<string, unknown>, method: string, path: string): Array<{ name: string; description?: string }> {
    const pathItem = ((spec as any).paths ?? {})[path];
    if (!pathItem) return [];
    const operation = pathItem[method];
    if (!operation) return [];
    const parameters = operation.parameters ?? [];
    return parameters.map((p: any) => ({ name: p.name, description: p.description ?? '' }));
  }

  function lookupParam(params: Array<{ name: string; description?: string }>, name: string) {
    return params.find((p) => p.name === name);
  }

  // ── GET /internal/indexer/events ──────────────────────────────────────────

  test('documents all expected query params for GET /internal/indexer/events', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events');
    const names = params.map((p) => p.name).sort();
    expect(names).toEqual([...eventsRequiredParams].sort());
  });

  test('fromLedger has inclusive-range description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events');
    const p = lookupParam(params, 'fromLedger');
    expect(p, 'fromLedger param missing').toBeDefined();
    expect(p!.description.toLowerCase()).toMatch(/inclusive/);
    expect(p!.description).toMatch(/at or after|>=|lower/);
  });

  test('toledger has inclusive-range description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events');
    const p = lookupParam(params, 'toledger');
    expect(p, 'toledger param missing').toBeDefined();
    expect(p!.description.toLowerCase()).toMatch(/inclusive/);
    expect(p!.description).toMatch(/at or before|<=|upper/);
  });

  test('limit has bounds description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events');
    const p = lookupParam(params, 'limit');
    expect(p, 'limit param missing').toBeDefined();
    expect(p!.description).toMatch(/100/);
    expect(p!.description).toMatch(/1000|maximum/);
  });

  test('offset has skip-semantics description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events');
    const p = lookupParam(params, 'offset');
    expect(p, 'offset param missing').toBeDefined();
    expect(p!.description).toMatch(/skip|offset/);
  });

  test('every events query param has a non-empty description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events');
    for (const name of eventsRequiredParams) {
      const p = lookupParam(params, name);
      expect(p, `${name} param missing from spec`).toBeDefined();
      expect(p!.description, `${name} param missing description`).toBeTruthy();
    }
  });

  // ── GET /internal/indexer/events/replay ───────────────────────────────────

  test('documents all expected query params for GET /internal/indexer/events/replay', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events/replay');
    const names = params.map((p) => p.name).sort();
    expect(names).toEqual([...replayRequiredParams].sort());
  });

  test('replay: fromLedger has inclusive-range description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events/replay');
    const p = lookupParam(params, 'fromLedger');
    expect(p, 'fromLedger param missing').toBeDefined();
    expect(p!.description.toLowerCase()).toMatch(/inclusive/);
  });

  test('replay: toledger has inclusive-range description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events/replay');
    const p = lookupParam(params, 'toledger');
    expect(p, 'toledger param missing').toBeDefined();
    expect(p!.description.toLowerCase()).toMatch(/inclusive/);
  });

  test('every replay query param has a non-empty description', () => {
    const spec = buildOpenApiSpec();
    const params = paramsForPath(spec, 'get', '/internal/indexer/events/replay');
    for (const name of replayRequiredParams) {
      const p = lookupParam(params, name);
      expect(p, `${name} param missing from spec`).toBeDefined();
      expect(p!.description, `${name} param missing description`).toBeTruthy();
    }
  });
});
