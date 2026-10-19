import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Maximum byte length of a PostgreSQL identifier (NAMEDATALEN - 1).
 */
export const MAX_REPLAY_INDEX_IDENTIFIER_LENGTH = 63;

/**
 * PostgreSQL allows at most 32 columns in an index. Reject anything larger
 * before the builder is touched.
 */
export const MAX_REPLAY_INDEX_COLUMNS = 32;

/**
 * Upper bound for the partial-index predicate. The table only needs a short
 * `WHERE ingested_at IS NULL` clause; anything larger is treated as misuse.
 */
export const MAX_REPLAY_INDEX_PREDICATE_LENGTH = 2048;

export type ReplayIndexOptionField =
  | 'definitions'
  | 'table'
  | 'columns'
  | 'name'
  | 'where';

export type ReplayIndexOptionReason =
  | 'missing'
  | 'empty'
  | 'malformed'
  | 'oversized';

/**
 * Typed rejection raised before the migration builder performs any work.
 *
 * `field` and `reason` let a caller distinguish a missing table from an empty
 * column list or an oversized predicate without parsing the message.
 */
export class InvalidReplayIndexOptionError extends Error {
  public readonly code = 'INVALID_REPLAY_INDEX_OPTION';

  constructor(
    public readonly field: ReplayIndexOptionField,
    public readonly reason: ReplayIndexOptionReason,
    public readonly detail: string,
  ) {
    super(`Invalid replay index ${field} (${reason}): ${detail}`);
    this.name = 'InvalidReplayIndexOptionError';
  }
}

export interface ReplayIndexDefinition {
  readonly table: string;
  readonly columns: readonly string[];
  readonly name: string;
  readonly where?: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const UNSAFE_PREDICATE_PATTERN = /;|--|\/\*|\*\//;

function reject(
  field: ReplayIndexOptionField,
  reason: ReplayIndexOptionReason,
  detail: string,
): never {
  throw new InvalidReplayIndexOptionError(field, reason, detail);
}

function validateIdentifier(
  value: unknown,
  field: 'table' | 'columns' | 'name',
  label: string,
): string {
  if (value === undefined || value === null) {
    reject(field, 'missing', `${label} is required`);
  }
  if (typeof value !== 'string') {
    reject(field, 'malformed', `${label} must be a string`);
  }
  if (value.trim().length === 0) {
    reject(field, 'empty', `${label} must not be empty`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_REPLAY_INDEX_IDENTIFIER_LENGTH) {
    reject(
      field,
      'oversized',
      `${label} exceeds ${MAX_REPLAY_INDEX_IDENTIFIER_LENGTH} bytes`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    reject(field, 'malformed', `${label} is not a valid PostgreSQL identifier`);
  }
  return value;
}

function validateColumns(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    reject('columns', 'missing', 'columns is required');
  }
  if (!Array.isArray(value)) {
    reject('columns', 'malformed', 'columns must be an array of identifiers');
  }
  if (value.length === 0) {
    reject('columns', 'empty', 'columns must contain at least one identifier');
  }
  if (value.length > MAX_REPLAY_INDEX_COLUMNS) {
    reject(
      'columns',
      'oversized',
      `columns exceeds the ${MAX_REPLAY_INDEX_COLUMNS}-column limit`,
    );
  }
  return value.map((column, index) =>
    validateIdentifier(column, 'columns', `columns[${index}]`),
  );
}

function validatePredicate(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    reject('where', 'malformed', 'where must be a string');
  }
  if (value.trim().length === 0) {
    reject('where', 'empty', 'where must not be empty when provided');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_REPLAY_INDEX_PREDICATE_LENGTH) {
    reject(
      'where',
      'oversized',
      `where exceeds ${MAX_REPLAY_INDEX_PREDICATE_LENGTH} bytes`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(value) || UNSAFE_PREDICATE_PATTERN.test(value)) {
    reject('where', 'malformed', 'where contains an unsafe SQL sequence');
  }
  return value;
}

/**
 * Validate a single index definition. All checks run before the returned
 * definition is used, so a rejected input never reaches the migration builder.
 */
export function validateReplayIndexDefinition(
  definition: unknown,
): ReplayIndexDefinition {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    reject('definitions', 'malformed', 'each index definition must be an object');
  }

  const candidate = definition as Partial<Record<keyof ReplayIndexDefinition, unknown>>;
  return {
    table: validateIdentifier(candidate.table, 'table', 'table'),
    columns: validateColumns(candidate.columns),
    name: validateIdentifier(candidate.name, 'name', 'name'),
    where: validatePredicate(candidate.where),
  };
}

function validateDefinitions(definitions: unknown): ReplayIndexDefinition[] {
  if (!Array.isArray(definitions)) {
    reject('definitions', 'malformed', 'definitions must be an array');
  }
  if (definitions.length === 0) {
    reject('definitions', 'empty', 'at least one index definition is required');
  }
  return definitions.map(validateReplayIndexDefinition);
}

export const REPLAY_INDEX_DEFINITIONS: readonly ReplayIndexDefinition[] = [
  {
    table: 'contract_events',
    columns: ['contract_id', 'ledger_sequence'],
    name: 'idx_contract_events_contract_ledger',
  },
  {
    table: 'contract_events',
    columns: ['contract_id'],
    name: 'idx_contract_events_replay_null_ingested',
    where: 'ingested_at IS NULL',
  },
];

/**
 * Creates indexes on the contract_events table concurrently.
 * * SECURITY & OPS NOTE:
 * We disable the transaction block via `pgm.noTransaction()` because PostgreSQL 
 * strictly forbids `CREATE INDEX CONCURRENTLY` inside a transaction block.
 * Building concurrently ensures we do not hold an exclusive lock that blocks writes 
 * to `contract_events` in production. 
 * * IF A MIGRATION FAILS: 
 * A failed CONCURRENTLY build can leave an INVALID index in Postgres. 
 * You must check `pg_index.indisvalid` and drop the invalid index manually 
 * before re-running the migration, otherwise query planning may degrade.
 *
 * Definitions are validated in full before `noTransaction()` or any DDL is
 * queued, so malformed input cannot leave partial state behind.
 */
export async function up(
  pgm: MigrationBuilder,
  definitions: readonly ReplayIndexDefinition[] = REPLAY_INDEX_DEFINITIONS,
): Promise<void> {
  const validated = validateDefinitions(definitions);

  // Disable transaction wrapping for this specific migration
  pgm.noTransaction();

  for (const definition of validated) {
    pgm.createIndex(definition.table, [...definition.columns], {
      name: definition.name,
      concurrently: true,
      ifNotExists: true,
      ...(definition.where === undefined ? {} : { where: definition.where }),
    });
  }
}

export async function down(
  pgm: MigrationBuilder,
  definitions: readonly ReplayIndexDefinition[] = REPLAY_INDEX_DEFINITIONS,
): Promise<void> {
  const validated = validateDefinitions(definitions);

  // Must also disable transaction for dropping indexes concurrently
  pgm.noTransaction();

  for (const definition of validated) {
    pgm.dropIndex(definition.table, [...definition.columns], {
      name: definition.name,
      concurrently: true,
      ifExists: true,
    });
  }
}
