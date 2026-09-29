import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_TYPE_CONTRACT,
  camelToSnake,
  compareDeclaredToLive,
  formatReport,
  parseDeclaredTypes,
  parseInterfaces,
  parseTypeAliases,
  resolveTsType,
} from './check-db-schema-types.mjs';

const TYPES_PATH = path.resolve('src/db/types.ts');

const column = (column_name, data_type, udt_name, is_nullable = 'NO') => ({
  column_name,
  data_type,
  udt_name,
  is_nullable,
});

/**
 * Mirror of the schema produced by the migrations (streams + api_keys +
 * partitioned contract_events), used to exercise the comparator without a
 * database. The extra streams columns are deliberately present: they are the
 * documented non-fatal drift the check reports.
 */
const LIVE_SCHEMA = {
  streams: [
    column('id', 'text', 'text'),
    column('sender_address', 'text', 'text'),
    column('sender_address_hash', 'text', 'text'),
    column('recipient_address', 'text', 'text'),
    column('recipient_address_hash', 'text', 'text'),
    column('amount', 'text', 'text'),
    column('streamed_amount', 'text', 'text'),
    column('remaining_amount', 'text', 'text'),
    column('rate_per_second', 'text', 'text'),
    column('start_time', 'bigint', 'int8'),
    column('end_time', 'bigint', 'int8'),
    column('status', 'text', 'text'),
    column('contract_id', 'text', 'text'),
    column('transaction_hash', 'text', 'text'),
    column('event_index', 'integer', 'int4'),
    column('created_at', 'timestamp with time zone', 'timestamptz'),
    column('updated_at', 'timestamp with time zone', 'timestamptz'),
    column('encryption_state', 'text', 'text'),
    column('legal_hold', 'boolean', 'bool'),
  ],
  api_keys: [
    column('id', 'text', 'text'),
    column('name', 'text', 'text'),
    column('key_hash', 'text', 'text'),
    column('salt', 'text', 'text'),
    column('prefix', 'text', 'text'),
    column('created_at', 'timestamp with time zone', 'timestamptz'),
    column('rotated_at', 'timestamp with time zone', 'timestamptz', 'YES'),
    column('active', 'boolean', 'bool'),
    // serialized string[] — the documented override target.
    column('scopes', 'text', 'text'),
  ],
  contract_events: [
    column('event_id', 'text', 'text'),
    column('ledger', 'integer', 'int4'),
    column('contract_id', 'text', 'text'),
    column('topic', 'text', 'text'),
    column('tx_hash', 'text', 'text'),
    column('tx_index', 'integer', 'int4'),
    column('operation_index', 'integer', 'int4'),
    column('event_index', 'integer', 'int4'),
    column('payload', 'jsonb', 'jsonb'),
    column('happened_at', 'timestamp with time zone', 'timestamptz'),
    // nullable in the partitioned schema (legacy rows predate the column).
    column('ledger_hash', 'text', 'text', 'YES'),
    column('ingested_at', 'timestamp with time zone', 'timestamptz'),
  ],
};

const cloneSchema = () => JSON.parse(JSON.stringify(LIVE_SCHEMA));

function compareWithLive(overrides = {}) {
  const parsed = parseDeclaredTypes(TYPES_PATH);
  const live = cloneSchema();
  for (const [table, mutate] of Object.entries(overrides)) mutate(live[table]);
  const { errors, reports } = compareDeclaredToLive(parsed.declared, live);
  return { errors, reports, declared: parsed.declared, live };
}

describe('parseInterfaces / parseTypeAliases', () => {
  it('parses the real declared interfaces and aliases', () => {
    const parsed = parseDeclaredTypes(TYPES_PATH);
    expect(Object.keys(parsed.interfaces.StreamRecord)).toHaveLength(15);
    expect(parsed.interfaces.StreamRecord.status.type).toBe('StreamStatus');
    expect(parsed.interfaces.StreamRecord.sender_address.type).toBe('string');

    expect(Object.keys(parsed.interfaces.ApiKeyRecord)).toHaveLength(9);
    expect(parsed.interfaces.ApiKeyRecord.keyHash.type).toBe('string');
    expect(parsed.interfaces.ApiKeyRecord.rotatedAt.type).toBe('string | null');
    expect(parsed.interfaces.ApiKeyRecord.scopes.type).toBe('string[]');

    expect(Object.keys(parsed.interfaces.StreamEventRecord)).toHaveLength(12);
    expect(parsed.interfaces.StreamEventRecord.payload.type).toBe('Record<string, unknown>');

    expect(parsed.aliases.StreamStatus).toContain('"active"');
  });

  it('does not let a {@link} reference inside JSDoc truncate an interface', () => {
    const source = [
      'export interface Foo {',
      '  /** @see {@link Bar} for details. */',
      '  id: string;',
      '  /** Optional counter. */',
      '  count?: number;',
      '}',
    ].join('\n');
    const parsed = parseInterfaces(source);
    expect(parsed.Foo).toEqual({
      id: { type: 'string', optional: false },
      count: { type: 'number', optional: true },
    });
  });

  it('resolves named type aliases', () => {
    const aliases = parseTypeAliases('export type Status = "a" | "b";');
    expect(resolveTsType('Status', aliases).family).toBe('text');
  });

  it('throws when a mapped interface disappears', () => {
    expect(() =>
      parseDeclaredTypes(TYPES_PATH, [{ table: 'lost', interfaceName: 'DoesNotExist' }]),
    ).toThrow(/DoesNotExist/);
  });
});

describe('camelToSnake', () => {
  it('maps camelCase properties and leaves snake_case untouched', () => {
    expect(camelToSnake('keyHash')).toBe('key_hash');
    expect(camelToSnake('eventId')).toBe('event_id');
    expect(camelToSnake('sender_address')).toBe('sender_address');
    expect(camelToSnake('id')).toBe('id');
  });
});

describe('resolveTsType', () => {
  const aliases = { StreamStatus: '"active" | "paused" | "completed" | "cancelled"' };
  it.each([
    ['string', 'text', false, false],
    ['number', 'integer', false, false],
    ['boolean', 'boolean', false, false],
    ['Record<string, unknown>', 'json', false, false],
    ['string[]', 'text', true, false],
    ['string | null', 'text', false, true],
    ['StreamStatus', 'text', false, false],
  ])('%s -> %s', (type, family, array, nullable) => {
    const resolved = resolveTsType(type, aliases);
    expect({ family: resolved.family, array: resolved.array, nullable: resolved.nullable }).toEqual(
      { family, array, nullable },
    );
  });
});

describe('compareDeclaredToLive against the migrated schema', () => {
  it('accepts every declared column and surfaces only the documented drift', () => {
    const { errors, reports } = compareWithLive();
    expect(errors).toEqual([]);

    const reported = reports.map((report) => `${report.table}.${report.column}`);
    expect(reported).toContain('streams.sender_address_hash');
    expect(reported).toContain('streams.recipient_address_hash');
    expect(reported).toContain('streams.encryption_state');
    expect(reported).toContain('streams.legal_hold');
    // declared non-null, nullable live column.
    expect(reported).toContain('contract_events.ledger_hash');
    expect(
      reports.filter((report) => report.code === 'UNDECLARED_COLUMN'),
    ).toHaveLength(4);
  });

  it('fails when a mapped column is renamed in a migration', () => {
    const { errors } = compareWithLive({
      streams: (columns) => {
        const target = columns.find((c) => c.column_name === 'sender_address');
        target.column_name = 'sender_addr';
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      table: 'streams',
      column: 'sender_address',
      property: 'sender_address',
      code: 'MISSING_COLUMN',
    });
  });

  it('fails when a mapped column is retyped in a migration', () => {
    const { errors } = compareWithLive({
      streams: (columns) => {
        const target = columns.find((c) => c.column_name === 'amount');
        target.data_type = 'integer';
        target.udt_name = 'int4';
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      table: 'streams',
      column: 'amount',
      property: 'amount',
      code: 'TYPE_MISMATCH',
    });
    expect(errors[0].message).toContain('live column is integer');
  });

  it('fails when a remapping retypes a numeric column to a non-numeric type', () => {
    const { errors } = compareWithLive({
      contract_events: (columns) => {
        const target = columns.find((c) => c.column_name === 'ledger');
        target.data_type = 'text';
        target.udt_name = 'text';
      },
    });
    expect(errors.map((error) => `${error.table}.${error.column}`)).toEqual([
      'contract_events.ledger',
    ]);
  });

  it('still catches a timestamp column retyped away from its pinned SQL type', () => {
    const { errors } = compareWithLive({
      streams: (columns) => {
        const target = columns.find((c) => c.column_name === 'created_at');
        target.data_type = 'integer';
        target.udt_name = 'int4';
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      table: 'streams',
      column: 'created_at',
      code: 'TYPE_MISMATCH',
    });
  });

  it('reports an undeclared column without failing', () => {
    const { errors, reports } = compareWithLive({
      streams: (columns) => columns.push(column('brand_new', 'text', 'text')),
    });
    expect(errors).toEqual([]);
    expect(reports.some((report) => report.column === 'brand_new')).toBe(true);
  });

  it('requires the explicit override for the JSON-serialized scopes column', () => {
    const withOverride = parseDeclaredTypes(TYPES_PATH);
    const withoutOverride = parseDeclaredTypes(TYPES_PATH, [
      { table: 'api_keys', interfaceName: 'ApiKeyRecord' },
    ]);
    const live = cloneSchema();

    const strict = compareDeclaredToLive(withoutOverride.declared, live);
    const scopesError = strict.errors.find((error) => error.column === 'scopes');
    expect(scopesError).toBeDefined();
    expect(scopesError.code).toBe('TYPE_MISMATCH');

    const declared = compareDeclaredToLive(withOverride.declared, live);
    expect(declared.errors).toEqual([]);
  });
});

describe('formatReport', () => {
  it('prints the OK banner when there are no errors', () => {
    const { errors, reports, declared, live } = compareWithLive();
    const output = formatReport({ declaredByTable: declared, liveByTable: live, errors, reports });
    expect(output).toContain('OK: every declared column is present');
    expect(output).toContain('Reported drift (non-fatal');
  });

  it('prints the failure banner and each error', () => {
    const { errors, reports, declared, live } = compareWithLive({
      api_keys: (columns) => {
        const target = columns.find((c) => c.column_name === 'active');
        target.data_type = 'text';
        target.udt_name = 'text';
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    const output = formatReport({ declaredByTable: declared, liveByTable: live, errors, reports });
    expect(output).toContain('FAILED');
    expect(output).toContain('api_keys.active');
  });
});

describe('contract wiring', () => {
  it('maps the three migrated tables to their declared interfaces', () => {
    expect(SCHEMA_TYPE_CONTRACT.map((entry) => entry.table)).toEqual([
      'streams',
      'api_keys',
      'contract_events',
    ]);
    expect(
      SCHEMA_TYPE_CONTRACT.find((entry) => entry.table === 'api_keys').overrides.scopes.pg,
    ).toEqual(['text']);
  });
});
