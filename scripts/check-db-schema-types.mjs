#!/usr/bin/env node

/**
 * Assert that the database row types declared in `src/db/types.ts` still match
 * the schema produced by the migrations.
 *
 * The declared interfaces are the application's contract with PostgreSQL: a
 * column that is renamed or retyped by a migration silently invalidates them
 * until the interface is updated, and the mismatch only surfaces later as a
 * runtime value of the wrong shape. This check reads both sides — the
 * TypeScript source and `information_schema` — and fails when they disagree,
 * so the drift is caught in CI instead of in production.
 *
 * Fatal (exit code 1)
 * -------------------
 *   * a declared property has no matching column — a migration renamed,
 *     dropped, or never created it.
 *   * a declared property's type family does not match the column's SQL type —
 *     a migration retyped it (e.g. `text` → `integer`).
 *
 * Reported but not fatal
 * ----------------------
 *   * a column that exists in the live schema but is absent from the mapped
 *     interface. Reported so the contract stays visible; not every internal
 *     column (hashes, encryption state, legal hold) is part of the domain
 *     shape, so this does not fail the build.
 *   * a declared non-null property backed by a nullable column.
 *
 * The check runs against the migrated test database (`pnpm run check:db-types`
 * with `DATABASE_URL` set, as CI does after applying migrations). Without a
 * `DATABASE_URL` it is skipped so local/offline runs stay lightweight,
 * mirroring the other live-database suites.
 *
 * @module scripts/check-db-schema-types
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

/** Default location of the declared row types, relative to the repo root. */
export const TYPES_SOURCE = 'src/db/types.ts';

/**
 * A timestamp column exposed to the domain as an ISO-8601 `string`.
 *
 * `types.ts` deliberately declares temporal columns as strings; the SQL type
 * is still pinned here, so a migration that retypes one of them is caught.
 */
const TIMESTAMP_AS_STRING = Object.freeze({
  pg: Object.freeze(['timestamp with time zone', 'timestamp without time zone']),
  reason: 'declared as an ISO-8601 string; the column stores a timestamp',
});

/**
 * A `string[]` exposed over a JSON-serialized `text` column.
 *
 * `apiKeyRepository.rowToApiKeyRecord` reads this column as a pg array OR a
 * JSON string and parses it back into `string[]` (migration 20260727000000).
 */
const JSON_SERIALIZED_ARRAY = Object.freeze({
  pg: Object.freeze(['text']),
  reason: 'JSON-serialized text column parsed into string[] by apiKeyRepository',
});

/**
 * Which declared interface maps to which table.
 *
 * `overrides` records a column whose storage representation deliberately does
 * not mirror the TypeScript type. Each override pins the accepted SQL types and
 * carries its reason so the exception is reviewable rather than silent.
 */
export const SCHEMA_TYPE_CONTRACT = Object.freeze([
  Object.freeze({
    table: 'streams',
    interfaceName: 'StreamRecord',
    overrides: Object.freeze({
      created_at: TIMESTAMP_AS_STRING,
      updated_at: TIMESTAMP_AS_STRING,
    }),
  }),
  Object.freeze({
    table: 'api_keys',
    interfaceName: 'ApiKeyRecord',
    overrides: Object.freeze({
      createdAt: TIMESTAMP_AS_STRING,
      rotatedAt: TIMESTAMP_AS_STRING,
      scopes: JSON_SERIALIZED_ARRAY,
    }),
  }),
  Object.freeze({
    table: 'contract_events',
    interfaceName: 'StreamEventRecord',
    overrides: Object.freeze({
      happenedAt: TIMESTAMP_AS_STRING,
      ingestedAt: TIMESTAMP_AS_STRING,
    }),
  }),
]);

/** PostgreSQL `data_type` values accepted for each TypeScript family. */
export const PG_TYPE_FAMILIES = Object.freeze({
  text: Object.freeze([
    'text',
    'character varying',
    'character',
    'bpchar',
    'uuid',
    'name',
    'citext',
  ]),
  integer: Object.freeze([
    'smallint',
    'integer',
    'bigint',
    'numeric',
    'decimal',
    'real',
    'double precision',
  ]),
  boolean: Object.freeze(['boolean']),
  json: Object.freeze(['json', 'jsonb']),
  timestamp: Object.freeze([
    'timestamp with time zone',
    'timestamp without time zone',
    'date',
    'time with time zone',
    'time without time zone',
  ]),
});

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*')
  );
}

function stripCommentLines(chunk) {
  return chunk
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .join('\n');
}

/**
 * Extract every `export interface Name { … }` and its declared properties.
 *
 * Braces are matched rather than regex-terminated so documented `{@link …}`
 * references inside JSDoc comments do not truncate the body.
 *
 * @returns {Record<string, Record<string, { type: string, optional: boolean }>>}
 */
export function parseInterfaces(source) {
  const interfaces = {};
  const pattern = /export\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    let depth = 1;
    let cursor = pattern.lastIndex;
    let end = -1;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end === -1) continue;
    interfaces[name] = parsePropertyBlock(source.slice(pattern.lastIndex, end));
    pattern.lastIndex = end + 1;
  }
  return interfaces;
}

function parsePropertyBlock(body) {
  const properties = {};
  for (const raw of body.split(';')) {
    const text = stripCommentLines(raw).trim();
    if (!text) continue;
    const match = text.match(/^([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/);
    if (!match) continue;
    properties[match[1]] = {
      type: collapseWhitespace(match[3]),
      optional: Boolean(match[2]),
    };
  }
  return properties;
}

/** Extract `export type Name = …;` aliases so named unions resolve. */
export function parseTypeAliases(source) {
  const aliases = {};
  const pattern = /export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    aliases[match[1]] = collapseWhitespace(match[2]);
  }
  return aliases;
}

/** `sender_address` stays put; `keyHash` becomes `key_hash`. */
export function camelToSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function primitiveFamily(typeText, aliases) {
  const text = collapseWhitespace(typeText);
  if (text === 'string') return 'text';
  if (text === 'number' || text === 'bigint') return 'integer';
  if (text === 'boolean') return 'boolean';
  if (text === 'Date') return 'timestamp';
  if (text === 'any' || text === 'unknown') return 'any';
  if (/^Record\s*</.test(text) || /^\{[\s\S]*\}$/.test(text) || text === 'object') {
    return 'json';
  }
  // Union of string literals (`"active" | "paused" | …`).
  if (/^("[^"]*"|'[^']*')(\s*\|\s*("[^"]*"|'[^']*'))*$/.test(text)) return 'text';
  // Union of numeric literals.
  if (/^-?\d+(\.\d+)?(\s*\|\s*-?\d+(\.\d+)?)*$/.test(text)) return 'integer';
  if (Object.prototype.hasOwnProperty.call(aliases, text)) {
    return resolveTsType(aliases[text], aliases).family;
  }
  // Unknown named types are accepted rather than guessed at; the missing-column
  // check still guards their presence in the live schema.
  return 'any';
}

/**
 * Resolve a declared TypeScript type into a storage family.
 *
 * @returns {{ family: string, array: boolean, nullable: boolean, resolvedFrom: string }}
 */
export function resolveTsType(typeText, aliases = {}) {
  const cleaned = collapseWhitespace(typeText);
  const nullable = /\bnull\b/.test(cleaned);
  let base = cleaned
    .replace(/\bnull\b/g, '')
    .replace(/\bundefined\b/g, '')
    .replace(/^\s*\|\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .trim();

  if (base === '') {
    return { family: 'any', array: false, nullable, resolvedFrom: typeText };
  }

  let array = false;
  let element = base;
  const arraySuffix = base.match(/^(.*?)\[\]$/);
  const arrayGeneric = base.match(/^Array<(.+)>$/);
  if (arraySuffix) {
    array = true;
    element = arraySuffix[1].trim();
  } else if (arrayGeneric) {
    array = true;
    element = arrayGeneric[1].trim();
  }

  // Resolve a named alias (e.g. `StreamStatus`) before inferring a family.
  if (!array && Object.prototype.hasOwnProperty.call(aliases, base)) {
    const inner = resolveTsType(aliases[base], aliases);
    return { ...inner, nullable: nullable || inner.nullable, resolvedFrom: typeText };
  }

  return {
    family: primitiveFamily(element, aliases),
    array,
    nullable,
    resolvedFrom: typeText,
  };
}

/**
 * Turn the declared interfaces into `table -> column -> expectation` pairs,
 * translating camelCase properties into their snake_case column names.
 */
export function buildDeclaredColumns(
  interfaces,
  aliases,
  contract = SCHEMA_TYPE_CONTRACT,
) {
  const declared = {};
  for (const entry of contract) {
    const properties = interfaces[entry.interfaceName];
    if (!properties) {
      throw new Error(
        `Declared interface ${entry.interfaceName} was not found in ${TYPES_SOURCE}`,
      );
    }
    const columns = {};
    for (const [property, descriptor] of Object.entries(properties)) {
      const resolved = resolveTsType(descriptor.type, aliases);
      columns[camelToSnake(property)] = {
        property,
        sqlType: resolved.family,
        array: resolved.array,
        nullable: resolved.nullable || descriptor.optional,
        override: entry.overrides?.[property] ?? null,
      };
    }
    declared[entry.table] = columns;
  }
  return declared;
}

/** Read and parse `src/db/types.ts` into the declared contract. */
export function parseDeclaredTypes(typesPath, contract = SCHEMA_TYPE_CONTRACT) {
  const source = fs.readFileSync(typesPath, 'utf8');
  const interfaces = parseInterfaces(source);
  const aliases = parseTypeAliases(source);
  return {
    source,
    interfaces,
    aliases,
    declared: buildDeclaredColumns(interfaces, aliases, contract),
  };
}

function describeLiveType(column) {
  if (column.data_type === 'ARRAY') return `${column.udt_name.replace(/^_/, '')}[]`;
  return column.data_type;
}

function isCompatible(column, spec) {
  // An explicit override pins the accepted SQL types regardless of the TS shape
  // (e.g. a JSON-serialized array stored in a single `text` column).
  if (spec.override) {
    return (
      spec.override.pg.includes(column.data_type) ||
      spec.override.pg.includes(column.udt_name)
    );
  }
  const accepted = PG_TYPE_FAMILIES[spec.sqlType];
  if (!accepted) return true; // `any` / unresolved — presence is the only guarantee.
  if (spec.array) {
    if (column.data_type !== 'ARRAY') return false;
    const element = column.udt_name.replace(/^_/, '');
    return accepted.includes(element);
  }
  return accepted.includes(column.data_type) || accepted.includes(column.udt_name);
}

/**
 * Compare declared expectations against introspected columns.
 *
 * Pure and side-effect free so the behaviour is unit-testable without a
 * database. `liveByTable` is `table -> information_schema.columns` rows.
 */
export function compareDeclaredToLive(declaredByTable, liveByTable) {
  const errors = [];
  const reports = [];

  for (const [table, columns] of Object.entries(declaredByTable)) {
    const live = liveByTable[table] ?? [];
    const liveByName = new Map(live.map((column) => [column.column_name, column]));

    for (const [column, spec] of Object.entries(columns)) {
      const actual = liveByName.get(column);
      if (!actual) {
        errors.push({
          table,
          column,
          property: spec.property,
          code: 'MISSING_COLUMN',
          expected: spec.array ? `${spec.sqlType}[]` : spec.sqlType,
          actual: null,
          message: `${table}.${column} (declared as \`${spec.property}: ${spec.array ? `${spec.sqlType}[]` : spec.sqlType}\`) has no column in the live schema`,
        });
        continue;
      }

      if (!isCompatible(actual, spec)) {
        errors.push({
          table,
          column,
          property: spec.property,
          code: 'TYPE_MISMATCH',
          expected: spec.override
            ? spec.override.pg.join(' | ')
            : spec.array
              ? `${spec.sqlType}[]`
              : spec.sqlType,
          actual: describeLiveType(actual),
          message: `${table}.${column} is declared as \`${spec.property}: ${spec.array ? `${spec.sqlType}[]` : spec.sqlType}\` but the live column is ${describeLiveType(actual)}`,
        });
      }

      if (!spec.nullable && actual.is_nullable === 'YES') {
        reports.push({
          table,
          column,
          code: 'NULLABLE_COLUMN',
          message: `${table}.${column} is declared non-null as \`${spec.property}\` but the live column allows NULL`,
        });
      }
    }

    for (const column of liveByName.values()) {
      if (!columns[column.column_name]) {
        reports.push({
          table,
          column: column.column_name,
          code: 'UNDECLARED_COLUMN',
          message: `${table}.${column.column_name} exists in the live schema but is not declared in the mapped interface`,
        });
      }
    }
  }

  return { errors, reports };
}

/** Introspect the mapped tables through `information_schema`. */
export async function introspectTables(client, tables) {
  const result = await client.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [tables],
  );
  const byTable = {};
  for (const table of tables) byTable[table] = [];
  for (const row of result.rows) {
    if (!byTable[row.table_name]) byTable[row.table_name] = [];
    byTable[row.table_name].push(row);
  }
  return byTable;
}

/** Render a deterministic operator-facing report. */
export function formatReport({ declaredByTable, liveByTable, errors, reports }) {
  const lines = ['DB schema/type consistency check (src/db/types.ts)'];
  for (const [table, columns] of Object.entries(declaredByTable)) {
    lines.push(
      `  ${table}: ${Object.keys(columns).length} declared column(s), ${(liveByTable[table] ?? []).length} live column(s)`,
    );
  }

  if (reports.length > 0) {
    lines.push('', `Reported drift (non-fatal, ${reports.length}):`);
    for (const report of reports) lines.push(`  - [${report.code}] ${report.message}`);
  }

  if (errors.length > 0) {
    lines.push('', `FAILED: ${errors.length} mismatch(es) between declared types and the live schema:`);
    for (const error of errors) lines.push(`  x [${error.code}] ${error.message}`);
  } else {
    lines.push(
      '',
      'OK: every declared column is present in the live schema with a compatible type.',
    );
  }

  return lines.join('\n');
}

/**
 * CLI entry point.
 *
 * @returns {Promise<number>} process exit code.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const typesPath = path.resolve(argv[0] ?? TYPES_SOURCE);
  if (!fs.existsSync(typesPath)) {
    console.error(`DB schema/type consistency check failed: ${typesPath} does not exist`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseDeclaredTypes(typesPath);
  } catch (error) {
    console.error(
      `DB schema/type consistency check failed while parsing ${typesPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.log(
      'DB schema/type consistency check skipped: DATABASE_URL is not set (set it to the migrated test database).',
    );
    return 0;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const tables = Object.keys(parsed.declared);
    const liveByTable = await introspectTables(client, tables);
    const { errors, reports } = compareDeclaredToLive(parsed.declared, liveByTable);
    console.log(
      formatReport({
        declaredByTable: parsed.declared,
        liveByTable,
        errors,
        reports,
      }),
    );
    return errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(
      `DB schema/type consistency check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
