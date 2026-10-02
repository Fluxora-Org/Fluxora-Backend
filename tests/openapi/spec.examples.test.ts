/**
 * OpenAPI example contract tests.
 *
 * Fails CI when:
 *  1. Any documented example (media `example`, `examples[].value`, schema-level
 *     `example`, parameter/header examples) does not validate against its schema.
 *  2. Any response that declares `content` has zero examples (204/304 and other
 *     body-less responses are exempt).
 *
 * Examples are the single source of truth for SDK fixtures — a non-validating
 * example must fail the pipeline before it reaches generated clients.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { app } from '../../src/app.js';

type Finding = { where: string; error?: string };

let spec: Record<string, unknown>;
const invalid: Finding[] = [];
const missing: Finding[] = [];
let validated = 0;

const ROOT_ID = 'https://fluxora.local/openapi.json';

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function ptr(segments: Array<string | number>): string {
  return (
    '#' +
    segments
      .map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1'))
      .map((s) => '/' + s)
      .join('')
  );
}

function hasExample(media: Record<string, unknown>): boolean {
  if (media['example'] !== undefined) return true;
  const examples = media['examples'];
  return isObj(examples) && Object.keys(examples).length > 0;
}

beforeAll(async () => {
  const res = await request(app).get('/openapi.json');
  expect(res.status).toBe(200);
  spec = res.body as Record<string, unknown>;

  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  addFormats(ajv);
  ajv.addSchema({ ...spec, $id: ROOT_ID });

  function validateExample(where: string, schemaPath: Array<string | number>, value: unknown): void {
    try {
      const validate = ajv.compile({ $ref: ROOT_ID + ptr(schemaPath) });
      validated += 1;
      if (!validate(value)) {
        invalid.push({
          where,
          error: (validate.errors ?? [])
            .map((e) => `${e.instancePath} ${e.message}`)
            .join('; '),
        });
      }
    } catch (err) {
      invalid.push({ where, error: `compile: ${(err as Error).message}` });
    }
  }

  function walkMedia(
    where: string,
    mediaPath: Array<string | number>,
    media: Record<string, unknown>
  ): void {
    const schema = media['schema'];
    if (!isObj(schema)) return;
    const schemaPath = [...mediaPath, 'schema'];
    if (media['example'] !== undefined) {
      validateExample(`${where} media.example`, schemaPath, media['example']);
    }
    const examples = media['examples'];
    if (isObj(examples)) {
      for (const [name, ex] of Object.entries(examples)) {
        if (isObj(ex) && 'value' in ex) {
          validateExample(`${where} media.examples.${name}`, schemaPath, ex['value']);
        }
      }
    }
  }

  function walkContent(
    where: string,
    contentPath: Array<string | number>,
    content: Record<string, unknown>
  ): void {
    for (const [mt, media] of Object.entries(content)) {
      if (isObj(media)) walkMedia(`${where} [${mt}]`, [...contentPath, mt], media);
    }
  }

  function walkSchema(
    where: string,
    schemaPath: Array<string | number>,
    schema: unknown
  ): void {
    if (!isObj(schema)) return;
    if (schema['example'] !== undefined) {
      validateExample(`${where} schema.example`, schemaPath, schema['example']);
    }
    const props = schema['properties'];
    if (isObj(props)) {
      for (const [k, v] of Object.entries(props)) {
        walkSchema(`${where}.${k}`, [...schemaPath, 'properties', k], v);
      }
    }
    if (Array.isArray(schema['items'])) {
      schema['items'].forEach((v, i) =>
        walkSchema(`${where}.items[${i}]`, [...schemaPath, 'items', i], v)
      );
    } else if (isObj(schema['items'])) {
      walkSchema(`${where}.items`, [...schemaPath, 'items'], schema['items']);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const sub = schema[key];
      if (Array.isArray(sub)) {
        sub.forEach((v, i) =>
          walkSchema(`${where}.${key}[${i}]`, [...schemaPath, key, i], v)
        );
      }
    }
  }

  const paths = spec['paths'] as Record<string, Record<string, unknown>>;
  const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

  for (const [p, pathItem] of Object.entries(paths)) {
    for (const method of HTTP) {
      const op = pathItem?.[method];
      if (!isObj(op)) continue;
      const opWhere = `${method.toUpperCase()} ${p}`;

      const rb = op['requestBody'];
      if (isObj(rb)) {
        const content = rb['content'];
        if (isObj(content)) {
          walkContent(`${opWhere} requestBody`, ['paths', p, method, 'requestBody', 'content'], content);
        }
      }

      const params = op['parameters'];
      if (Array.isArray(params)) {
        params.forEach((param, i) => {
          if (!isObj(param)) return;
          const schema = param['schema'];
          if (isObj(schema) && param['example'] !== undefined) {
            validateExample(
              `${opWhere} param[${param['name']}].example`,
              ['paths', p, method, 'parameters', i, 'schema'],
              param['example']
            );
          }
          const examples = param['examples'];
          if (isObj(examples) && isObj(schema)) {
            for (const [name, ex] of Object.entries(examples)) {
              if (isObj(ex) && 'value' in ex) {
                validateExample(
                  `${opWhere} param[${param['name']}].examples.${name}`,
                  ['paths', p, method, 'parameters', i, 'schema'],
                  ex['value']
                );
              }
            }
          }
          if (isObj(schema)) {
            walkSchema(
              `${opWhere} param[${param['name']}]`,
              ['paths', p, method, 'parameters', i, 'schema'],
              schema
            );
          }
        });
      }

      const responses = op['responses'];
      if (!isObj(responses)) continue;
      for (const [status, resp] of Object.entries(responses)) {
        if (!isObj(resp)) continue;
        const rWhere = `${opWhere} → ${status}`;
        const content = resp['content'];
        if (isObj(content)) {
          walkContent(rWhere, ['paths', p, method, 'responses', status, 'content'], content);
          let any = false;
          for (const media of Object.values(content)) {
            if (isObj(media) && hasExample(media)) any = true;
          }
          if (!any) missing.push({ where: rWhere });
        }
        const headers = resp['headers'];
        if (isObj(headers)) {
          for (const [hn, h] of Object.entries(headers)) {
            if (!isObj(h)) continue;
            const schema = h['schema'];
            if (isObj(schema)) {
              walkSchema(
                `${rWhere} header.${hn}`,
                ['paths', p, method, 'responses', status, 'headers', hn, 'schema'],
                schema
              );
              if (h['example'] !== undefined) {
                validateExample(
                  `${rWhere} header.${hn}.example`,
                  ['paths', p, method, 'responses', status, 'headers', hn, 'schema'],
                  h['example']
                );
              }
            }
          }
        }
      }
    }
  }

  const schemas = ((spec['components'] as Record<string, unknown>)?.['schemas'] ??
    {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(schemas)) {
    walkSchema(`components.schemas.${name}`, ['components', 'schemas', name], schema);
  }
});

describe('OpenAPI examples validate against their schemas', () => {
  it('finds at least one example in the document (sanity)', () => {
    expect(validated).toBeGreaterThan(0);
  });

  it('every example validates against its schema', () => {
    expect(
      invalid,
      invalid.map((f) => `${f.where}: ${f.error}`).join('\n')
    ).toHaveLength(0);
  });
});

describe('Every content-bearing response documents at least one example', () => {
  it('no response with content is missing an example', () => {
    expect(
      missing.map((f) => f.where),
      `Responses missing examples:\n${missing.map((f) => `  - ${f.where}`).join('\n')}`
    ).toHaveLength(0);
  });
});
