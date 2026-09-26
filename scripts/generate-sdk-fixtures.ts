/**
 * Generate SDK fixtures from OpenAPI examples in `src/openapi/spec.ts`.
 *
 * Examples in the OpenAPI document are the single source of truth for SDK
 * fixtures. This script extracts every documented example and writes:
 *
 *   - `sdk/typescript/src/fixtures.ts`
 *   - `sdk/python/fluxora/fixtures.py`
 *
 * Usage:
 *   tsx scripts/generate-sdk-fixtures.ts            # write fixtures
 *   tsx scripts/generate-sdk-fixtures.ts --check    # fail if fixtures drift
 *
 * CI runs `--check` so a stale or hand-edited fixtures file fails the pipeline.
 *
 * @module scripts/generate-sdk-fixtures
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import '../tests/env-defaults.js';
import { buildOpenApiSpec } from '../src/openapi/spec.js';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

const isCheck = process.argv.includes('--check');
const ROOT = path.resolve(__dirname, '..');
const TS_OUT = path.join(ROOT, 'sdk/typescript/src/fixtures.ts');
const PY_OUT = path.join(ROOT, 'sdk/python/fluxora/fixtures.py');

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

interface Collected {
  responses: Record<string, Record<string, Record<string, Json>>>;
  requestBodies: Record<string, Record<string, Record<string, Json>>>;
  parameters: Record<string, Record<string, Json>>;
  headers: Record<string, Record<string, Json>>;
  schemas: Record<string, Json>;
}

function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJson);
  if (isObj(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  return null;
}

function collectExamples(spec: Record<string, unknown>): Collected {
  const collected: Collected = {
    responses: {},
    requestBodies: {},
    parameters: {},
    headers: {},
    schemas: {},
  };

  function walkMediaInto(
    bucket: Record<string, Record<string, Record<string, Json>>>,
    key: string,
    mediaType: string,
    media: Obj
  ): void {
    if (!isObj(bucket[key])) bucket[key] = {};
    const byType = bucket[key];
    if (!isObj(byType[mediaType])) byType[mediaType] = {};
    const byName = byType[mediaType] as Record<string, Json>;

    if (media['example'] !== undefined) {
      byName['default'] = toJson(media['example']);
    }
    const examples = media['examples'];
    if (isObj(examples)) {
      for (const [name, ex] of Object.entries(examples)) {
        if (isObj(ex) && 'value' in ex) {
          byName[name] = toJson(ex['value']);
        }
      }
    }
  }

  const paths = (spec['paths'] ?? {}) as Record<string, Obj>;
  const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

  for (const [p, pathItem] of Object.entries(paths)) {
    for (const method of HTTP) {
      const op = pathItem?.[method];
      if (!isObj(op)) continue;
      const opKey = `${method.toUpperCase()} ${p}`;

      const rb = op['requestBody'];
      if (isObj(rb) && isObj(rb['content'])) {
        for (const [mt, media] of Object.entries(rb['content'] as Obj)) {
          if (isObj(media)) {
            walkMediaInto(collected.requestBodies, opKey, mt, media);
          }
        }
      }

      const params = op['parameters'];
      if (Array.isArray(params)) {
        for (const param of params) {
          if (!isObj(param)) continue;
          const name = String(param['name'] ?? '');
          const pKey = `${opKey} ${name}`;
          if (param['example'] !== undefined) {
            if (!isObj(collected.parameters[pKey])) collected.parameters[pKey] = {};
            (collected.parameters[pKey] as Record<string, Json>)['default'] = toJson(
              param['example']
            );
          }
          const pExamples = param['examples'];
          if (isObj(pExamples)) {
            if (!isObj(collected.parameters[pKey])) collected.parameters[pKey] = {};
            for (const [ename, ex] of Object.entries(pExamples)) {
              if (isObj(ex) && 'value' in ex) {
                (collected.parameters[pKey] as Record<string, Json>)[ename] = toJson(ex['value']);
              }
            }
          }
        }
      }

      const responses = op['responses'];
      if (!isObj(responses)) continue;
      for (const [status, resp] of Object.entries(responses)) {
        if (!isObj(resp)) continue;
        const rKey = `${opKey} → ${status}`;
        const content = resp['content'];
        if (isObj(content)) {
          for (const [mt, media] of Object.entries(content)) {
            if (isObj(media)) walkMediaInto(collected.responses, rKey, mt, media);
          }
        }
        const headers = resp['headers'];
        if (isObj(headers)) {
          for (const [hn, h] of Object.entries(headers)) {
            if (!isObj(h)) continue;
            const hKey = `${rKey} ${hn}`;
            if (h['example'] !== undefined) {
              if (!isObj(collected.headers[hKey])) collected.headers[hKey] = {};
              (collected.headers[hKey] as Record<string, Json>)['default'] = toJson(h['example']);
            }
            const hExamples = h['examples'];
            if (isObj(hExamples)) {
              if (!isObj(collected.headers[hKey])) collected.headers[hKey] = {};
              for (const [ename, ex] of Object.entries(hExamples)) {
                if (isObj(ex) && 'value' in ex) {
                  (collected.headers[hKey] as Record<string, Json>)[ename] = toJson(ex['value']);
                }
              }
            }
            const hs = h['schema'];
            if (isObj(hs) && hs['example'] !== undefined) {
              if (!isObj(collected.headers[hKey])) collected.headers[hKey] = {};
              (collected.headers[hKey] as Record<string, Json>)['default'] = toJson(hs['example']);
            }
          }
        }
      }
    }
  }

  function walkSchemaExamples(schema: unknown, outKey: string | null): void {
    if (!isObj(schema)) return;
    if (schema['example'] !== undefined) {
      const key = outKey ?? 'example';
      collected.schemas[key] = toJson(schema['example']);
    }
    const props = schema['properties'];
    if (isObj(props)) {
      for (const [k, v] of Object.entries(props)) {
        walkSchemaExamples(v, outKey ? `${outKey}.${k}` : k);
      }
    }
    if (isObj(schema['items'])) {
      walkSchemaExamples(schema['items'], outKey ? `${outKey}[]` : 'items');
    }
    for (const comb of ['allOf', 'anyOf', 'oneOf'] as const) {
      const sub = schema[comb];
      if (Array.isArray(sub)) {
        sub.forEach((v, i) => walkSchemaExamples(v, outKey ? `${outKey}.${comb}[${i}]` : `${comb}[${i}]`));
      }
    }
  }

  const schemas = ((spec['components'] as Obj | undefined)?.['schemas'] ?? {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(schemas)) {
    walkSchemaExamples(schema, name);
  }

  return collected;
}

function toPython(value: Json, indent = 1): string {
  const pad = '    '.repeat(indent);
  const pad0 = '    '.repeat(indent - 1);
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${pad}${toPython(v, indent + 1)},`);
    return `[\n${items.join('\n')}\n${pad0}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const items = entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${toPython(v, indent + 1)},`);
  return `{\n${items.join('\n')}\n${pad0}}`;
}

function generateTs(fixtures: Collected): string {
  return `/**
 * SDK fixtures derived from OpenAPI examples in \`src/openapi/spec.ts\`.
 *
 * Generated by \`scripts/generate-sdk-fixtures.ts\` — do not edit by hand.
 * Run \`pnpm generate:sdk:fixtures\` after changing OpenAPI examples.
 *
 * @module @fluxora/sdk/fixtures
 */

export const openApiFixtures = ${JSON.stringify(fixtures, null, 2)} as const;

export type OpenApiFixtures = typeof openApiFixtures;
`;
}

function generatePy(fixtures: Collected): string {
  const header = [
    '"""',
    'SDK fixtures derived from OpenAPI examples in src/openapi/spec.ts.',
    '',
    'Generated by scripts/generate-sdk-fixtures.ts — do not edit by hand.',
    'Run `pnpm generate:sdk:fixtures` after changing OpenAPI examples.',
    '"""',
    '',
    'from typing import Any, Dict',
    '',
    'OPENAPI_FIXTURES: Dict[str, Any] = ',
  ].join('\n');
  return header + toPython(toJson(fixtures) as Json, 1) + '\n';
}

function normalise(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

function checkOrWrite(relPath: string, fullPath: string, content: string): boolean {
  const expected = normalise(content);
  if (isCheck) {
    if (!fs.existsSync(fullPath)) {
      console.error(`[DRIFT DETECTED] Missing file: ${relPath}`);
      return false;
    }
    const existing = normalise(fs.readFileSync(fullPath, 'utf8'));
    if (existing !== expected) {
      console.error(`[DRIFT DETECTED] Content mismatch: ${relPath}`);
      return false;
    }
    return true;
  }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.replace(/\r\n/g, '\n'), 'utf8');
  console.log(`  Wrote ${relPath}`);
  return true;
}

function main(): void {
  const spec = buildOpenApiSpec();
  const fixtures = collectExamples(spec);

  const tsRel = 'sdk/typescript/src/fixtures.ts';
  const pyRel = 'sdk/python/fluxora/fixtures.py';

  if (isCheck) {
    console.log('[Fixtures drift check] Comparing generated fixtures against disk...');
    const ok =
      checkOrWrite(tsRel, TS_OUT, generateTs(fixtures)) &
      checkOrWrite(pyRel, PY_OUT, generatePy(fixtures));
    if (!ok) {
      console.error(
        '\n[DRIFT CHECK FAILED] SDK fixtures are stale. Run `pnpm generate:sdk:fixtures` and commit the result.'
      );
      process.exit(1);
    }
    console.log('[DRIFT CHECK PASSED] SDK fixtures match OpenAPI examples.');
    process.exit(0);
  }

  console.log('Generating SDK fixtures from OpenAPI examples...');
  checkOrWrite(tsRel, TS_OUT, generateTs(fixtures));
  checkOrWrite(pyRel, PY_OUT, generatePy(fixtures));
  console.log('[FIXTURES COMPLETE] Wrote TypeScript and Python fixtures.');
}

main();
