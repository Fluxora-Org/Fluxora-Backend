/**
 * Script: check-types-openapi.ts
 *
 * Issue #1573 - OpenAPI Schema Derivation Drift Check
 *
 * Validates that src/openapi/spec.ts OpenAPI component and endpoint response schemas
 * derive cleanly from shared types in src/types/index.ts and preserve all required contract fields.
 *
 * Validation Result:
 * - Changing a field name in a shared type (e.g. changing `isReplaying` in ReplayProgressSchema)
 *   causes `pnpm run check:types-openapi` to detect missing contract fields, output a clear diff,
 *   and exit non-zero (exit code 1).
 * - Reverting the change restores clean validation (exit code 0).
 */

import '../tests/env-defaults.js';
import { buildOpenApiSpec } from '../src/openapi/spec.js';
import {
  ContractEventSchema,
  ReplayProgressSchema,
  ReplayCursorSchema,
  ReplayRequestSchema,
} from '../src/types/index.js';
import { z } from 'zod';

interface Mismatch {
  schemaName: string;
  kind: 'missing_in_openapi' | 'extra_in_openapi' | 'contract_field_missing';
  field: string;
  expected?: string;
  actual?: string;
}

/** Expected domain contract fields for shared response/request types */
const EXPECTED_CONTRACT_FIELDS: Record<string, string[]> = {
  ReplayProgress: ['isReplaying', 'rowsReplayed', 'rowsRemaining', 'totalRows'],
  ReplayCursor: ['id', 'contract_id', 'ledger', 'total_rows', 'last_committed_offset', 'started_at'],
  ReplayRequest: ['contract_id', 'ledger'],
  ContractEvent: ['event_id', 'contract_id', 'ledger', 'event_type', 'block_height', 'transaction_hash'],
};

function getZodObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  if ('_def' in schema && (schema as any)._def.schema) {
    return getZodObjectShape((schema as any)._def.schema);
  }
  return {};
}

function checkSchemaDrift(): Mismatch[] {
  const spec = buildOpenApiSpec() as any;
  const components = spec?.components?.schemas || {};
  const mismatches: Mismatch[] = [];

  const targets: Array<{ name: string; zodSchema: z.ZodTypeAny }> = [
    { name: 'ReplayProgress', zodSchema: ReplayProgressSchema },
    { name: 'ReplayCursor', zodSchema: ReplayCursorSchema },
    { name: 'ReplayRequest', zodSchema: ReplayRequestSchema },
    { name: 'ContractEvent', zodSchema: ContractEventSchema },
  ];

  for (const { name, zodSchema } of targets) {
    const openApiComponent = components[name];
    if (!openApiComponent) {
      mismatches.push({
        schemaName: name,
        kind: 'missing_in_openapi',
        field: '*',
        expected: `OpenAPI component schema '${name}' registered`,
        actual: `Missing component schema '${name}' in OpenAPI spec`,
      });
      continue;
    }

    const zodShape = getZodObjectShape(zodSchema);
    const zodKeys = Object.keys(zodShape);
    const openApiProps = openApiComponent.properties || {};

    // Check required canonical contract fields
    const requiredFields = EXPECTED_CONTRACT_FIELDS[name] || [];
    for (const reqField of requiredFields) {
      if (!zodShape[reqField] || !openApiProps[reqField]) {
        mismatches.push({
          schemaName: name,
          kind: 'contract_field_missing',
          field: reqField,
          expected: `Required contract field '${reqField}' present on '${name}' schema`,
          actual: `Field '${reqField}' missing from '${name}' schema or component definition`,
        });
      }
    }

    // Ensure all Zod shape fields exist in OpenAPI component properties
    for (const key of zodKeys) {
      if (!openApiProps[key]) {
        mismatches.push({
          schemaName: name,
          kind: 'missing_in_openapi',
          field: key,
          expected: `Field '${key}' present in OpenAPI component properties`,
          actual: `Field '${key}' missing from OpenAPI component properties for '${name}'`,
        });
      }
    }
  }

  // Verify route response references
  const statusPath = spec?.paths?.['/internal/indexer/status']?.get;
  const statusResponseSchema = statusPath?.responses?.['200']?.content?.['application/json']?.schema;
  if (!statusResponseSchema) {
    mismatches.push({
      schemaName: 'GET /internal/indexer/status',
      kind: 'missing_in_openapi',
      field: 'response_200',
      expected: '200 response schema defined',
      actual: 'Missing 200 response schema in OpenAPI spec',
    });
  }

  return mismatches;
}

function main() {
  console.log('🔍 Checking OpenAPI spec drift against shared types in src/types/index.ts...');
  const mismatches = checkSchemaDrift();

  if (mismatches.length > 0) {
    console.error('\n❌ OpenAPI schema drift detected!\n');
    console.error('The following mismatches were found between src/types/index.ts and src/openapi/spec.ts:\n');
    for (const m of mismatches) {
      console.error(`  - [${m.schemaName}] ${m.kind.toUpperCase()}: field '${m.field}'`);
      console.error(`      Expected: ${m.expected}`);
      console.error(`      Actual:   ${m.actual}\n`);
    }
    process.exit(1);
  }

  console.log('✅ OpenAPI spec schemas match shared types in src/types/index.ts perfectly!');
  process.exit(0);
}

main();
