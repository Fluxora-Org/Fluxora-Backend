#!/usr/bin/env node

/**
 * API changelog validation for `docs/api/changelog.md`.
 *
 * The changelog is the single consumer-facing record of externally visible API
 * changes. It is grouped by API version, and breaking changes carry an explicit
 * `[breaking]` token. This script keeps that record truthful by comparing it
 * against the programmatic sources of truth:
 *
 *   - `openapi.yaml`                 — the published API surface (operations
 *                                      plus the shared contract outside `paths`).
 *   - `docs/api/releases.json`       — the contract released for each head API
 *                                      version, regenerated with `--update-release`.
 *   - `src/middleware/apiVersion.ts` — `SUPPORTED_VERSIONS` naming every served
 *                                      API version that must have a section.
 *   - `src/config/deprecations.ts`   — every registered route retirement that
 *                                      must be announced (and vice versa).
 *
 * The check is fail-closed: an unrecognized declaration format, an unparseable
 * document, or any of the invariants below failing blocks the build. It never
 * edits the changelog; only the release snapshot is regenerated, and only when
 * `--update-release` is passed.
 *
 * Invariants enforced:
 *
 *   1. The changelog parses into version sections and `Added` / `Changed` /
 *      `Fixed` / `Deprecated` / `Removed` groups, newest section first, with at
 *      most one entry per scope per version.
 *   2. Every served API version has a section, the head section is one of the
 *      served versions, and `DEFAULT_API_VERSION` is served.
 *   3. The set of endpoints the changelog declares live (added and never
 *      removed) exactly equals the endpoint set in `openapi.yaml`. Adding or
 *      removing an endpoint without an entry therefore fails.
 *   4. Every deprecated route in `src/config/deprecations.ts` has a matching
 *      `### Deprecated` entry carrying its `YYYY-MM-DD` sunset date, and every
 *      deprecation announced in the head section is registered.
 *   5. `### Removed` entries always carry `[breaking]`, and `[breaking]` never
 *      appears on `Added` or `Deprecated` entries.
 *   6. Every change to the released contract since `docs/api/releases.json` —
 *      an operation, the shared contract, or a deprecation — has a matching
 *      entry in the head section. Breaking changes must be marked
 *      `[breaking]`; documentation-only changes must not.
 *   7. The release snapshot matches the current contract, so a change cannot be
 *      published without regenerating it (`--update-release`).
 *
 * Usage:
 *   node scripts/check-api-changelog.mjs
 *   node scripts/check-api-changelog.mjs --check
 *   node scripts/check-api-changelog.mjs --changelog <path> --spec <path> \
 *     --api-version <path> --deprecations <path> --release <path>
 *   node scripts/check-api-changelog.mjs --update-release
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

export const KINDS = ['Added', 'Changed', 'Fixed', 'Deprecated', 'Removed'];
export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
export const DEPRECATED_METHOD = 'ALL';
export const GLOBAL_SCOPE = '*';
export const BREAKING_MARKER = '[breaking]';

export const DEFAULT_PATHS = {
  changelog: 'docs/api/changelog.md',
  spec: 'openapi.yaml',
  apiVersion: 'src/middleware/apiVersion.ts',
  deprecations: 'src/config/deprecations.ts',
  release: 'docs/api/releases.json',
};

const ARG_KEY_TO_PATH_KEY = {
  changelog: 'changelogPath',
  spec: 'specPath',
  'api-version': 'apiVersionPath',
  deprecations: 'deprecationsPath',
  release: 'releasePath',
};

const CONTRACT_METADATA_KEYS = new Set(['description', 'example', 'examples', 'externalDocs', 'summary']);
const GLOBAL_METADATA_KEYS = new Set(['externalDocs', 'info', 'openapi', 'tags']);
const NAMED_MAP_KEYS = new Set([
  '$defs',
  'callbacks',
  'content',
  'definitions',
  'dependentSchemas',
  'encoding',
  'examples',
  'headers',
  'links',
  'mapping',
  'parameters',
  'patternProperties',
  'paths',
  'properties',
  'requestBodies',
  'responses',
  'schemas',
  'scopes',
  'securitySchemes',
  'variables',
]);

/**
 * A validation failure with a stable machine-readable `code`, so callers can
 * branch on the reason instead of matching message text.
 */
export class ChangelogError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ChangelogError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(message, code, details = {}) {
  throw new ChangelogError(message, code, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function versionSectionRegex() {
  return /^##\s+(v\d+(?:\.\d+)*)\s*$/;
}

function kindRegex() {
  return /^###\s+(Added|Changed|Fixed|Deprecated|Removed)\s*$/;
}

function scopeRegex() {
  return /^(\*|[A-Za-z]+\s+\/[^\s]*)$/;
}

function parseEntry(body, lineNumber) {
  const match = /^`([^`]+)`([\s\S]*)$/.exec(body);
  if (!match) {
    fail(`line ${lineNumber}: entry must start with a backticked \`SCOPE\``, 'ENTRY_SCOPE_MISSING', {
      line: lineNumber,
    });
  }

  const scope = match[1].trim();
  let tail = match[2].trim();
  const breaking = /^\[breaking\](?=\s|$)/.test(tail);
  if (breaking) tail = tail.replace(/^\[breaking\]/, '').trim();

  const separator = /^(?:-|–|—)\s+(\S[\s\S]*)$/.exec(tail);
  if (!separator) {
    fail(`line ${lineNumber}: entry must be of the form "- \`SCOPE\` — description"`, 'ENTRY_DESCRIPTION_MISSING', {
      line: lineNumber,
    });
  }

  const description = separator[1].trim();
  const scopeMatch = scopeRegex().exec(scope);
  if (!scopeMatch) {
    fail(`line ${lineNumber}: invalid scope token \`${scope}\` (expected \`METHOD /path\` or \`*\`)`, 'SCOPE_INVALID', {
      scope,
      line: lineNumber,
    });
  }

  if (scope === GLOBAL_SCOPE) {
    return { scope, method: GLOBAL_SCOPE, path: GLOBAL_SCOPE, breaking, description, line: lineNumber };
  }

  return {
    scope,
    method: scopeMatch[0].split(/\s+/, 1)[0].toUpperCase(),
    path: scopeMatch[0].slice(scopeMatch[0].indexOf('/')),
    breaking,
    description,
    line: lineNumber,
  };
}

function compareVersions(a, b) {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  const length = Math.max(pa.length, pb.length);
  for (let index = 0; index < length; index += 1) {
    const x = pa[index] ?? 0;
    const y = pb[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Parse a changelog document into `{ sections }`. Throws `ChangelogError` on
 * any structural violation so malformed files fail closed.
 */
export function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const seenVersions = new Set();
  let current = null;
  let currentKind = null;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;

    const depth = /^(#{2,})\s/.exec(trimmed)?.[1].length ?? 0;
    if (depth > 3) {
      fail(`line ${index + 1}: headings must be \`##\` (version) or \`###\` (kind) only`, 'HEADING_DEPTH_INVALID', {
        line: index + 1,
      });
    }

    if (depth === 0) {
      const bullet = /^-\s+/.exec(trimmed);
      if (!bullet || !current) continue;
      if (!/^-\s+`/.test(trimmed)) continue;
      if (!currentKind) {
        fail(`line ${index + 1}: entry outside of a version section and change group`, 'ENTRY_OUTSIDE_SECTION', {
          line: index + 1,
        });
      }
      const parsed = parseEntry(trimmed.slice(bullet[0].length), index + 1);
      if (current.scopes.has(parsed.scope)) {
        fail(`line ${index + 1}: duplicate entry for scope \`${parsed.scope}\` in ${current.version}`, 'ENTRY_DUPLICATE', {
          scope: parsed.scope,
          version: current.version,
          line: index + 1,
        });
      }
      current.scopes.add(parsed.scope);
      current.entries.push({ ...parsed, kind: currentKind });
      continue;
    }

    if (depth === 2) {
      const versionMatch = versionSectionRegex().exec(trimmed);
      if (versionMatch) {
        const version = versionMatch[1];
        if (seenVersions.has(version)) {
          fail(`line ${index + 1}: duplicate section for API version ${version}`, 'VERSION_DUPLICATE', {
            version,
            line: index + 1,
          });
        }
        seenVersions.add(version);
        current = { version, entries: [], scopes: new Set() };
        currentKind = null;
        sections.push(current);
        continue;
      }
      if (!current) continue;
      fail(`line ${index + 1}: invalid version heading \`${trimmed}\``, 'VERSION_HEADING_INVALID', {
        line: index + 1,
      });
    }

    if (depth === 3) {
      if (!current) continue;
      const kindMatch = kindRegex().exec(trimmed);
      if (!kindMatch) {
        fail(`line ${index + 1}: unknown change group \`${trimmed}\` (expected one of ${KINDS.join(', ')})`, 'KIND_HEADING_INVALID', {
          line: index + 1,
        });
      }
      currentKind = kindMatch[1];
    }
  }

  if (sections.length === 0) fail('no API version sections found', 'NO_SECTIONS');

  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1].version;
    const next = sections[index].version;
    if (compareVersions(previous, next) !== 1) {
      fail(`version sections must be ordered newest first (${previous} before ${next})`, 'SECTIONS_OUT_OF_ORDER', {
        prev: previous,
        next,
      });
    }
  }

  return { sections };
}

function parseTypeScript(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length > 0) {
    const diagnostic = source.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    fail(`unable to parse ${fileName}: ${message}`, 'SOURCE_UNPARSEABLE');
  }
  return source;
}

function exportedVariable(source, name) {
  const declarations = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        declarations.push(declaration);
      }
    }
  }
  if (declarations.length !== 1) {
    fail(`unable to locate the exported ${name} declaration`, 'DECLARATION_UNPARSEABLE', { name });
  }
  return declarations[0];
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function stringValue(node, context) {
  const expression = unwrapExpression(node);
  if (!expression || !ts.isStringLiteralLike(expression)) {
    fail(`${context} must be a string literal`, 'STRING_LITERAL_INVALID', { context });
  }
  return expression.text;
}

/**
 * Extract `{ supported, defaultVersion }` from `src/middleware/apiVersion.ts`.
 * Fails closed if the declaration shape changes, so the check can never
 * silently stop covering a served version.
 */
export function extractApiVersions(text) {
  const source = parseTypeScript(text, 'src/middleware/apiVersion.ts');
  const supportedDeclaration = exportedVariable(source, 'SUPPORTED_VERSIONS');
  const defaultDeclaration = exportedVariable(source, 'DEFAULT_API_VERSION');
  const supportedExpression = unwrapExpression(supportedDeclaration.initializer);
  if (!supportedExpression || !ts.isArrayLiteralExpression(supportedExpression)) {
    fail('SUPPORTED_VERSIONS must be initialized with an array literal', 'VERSIONS_INVALID');
  }

  const supported = supportedExpression.elements.map((element, index) =>
    stringValue(element, `SUPPORTED_VERSIONS[${index}]`),
  );
  if (supported.length === 0) fail('SUPPORTED_VERSIONS must not be empty', 'VERSIONS_EMPTY');
  if (new Set(supported).size !== supported.length) fail('SUPPORTED_VERSIONS must not contain duplicates', 'VERSIONS_DUPLICATE');
  if (supported.some((version) => !/^v\d+(?:\.\d+)*$/.test(version))) {
    fail(`SUPPORTED_VERSIONS contains a value that is not an API version: ${supported.join(', ')}`, 'VERSIONS_INVALID', {
      supported,
    });
  }

  const defaultVersion = stringValue(defaultDeclaration.initializer, 'DEFAULT_API_VERSION');
  if (!supported.includes(defaultVersion)) {
    fail(`DEFAULT_API_VERSION ${defaultVersion} is not present in SUPPORTED_VERSIONS`, 'DEFAULT_VERSION_INVALID');
  }
  return { supported, defaultVersion };
}

function propertyName(property) {
  if (!ts.isPropertyAssignment(property) || property.computed) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) return property.name.text;
  return null;
}

function isRelativeMigrationLink(value) {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  try {
    const base = new URL('https://docs.fluxora.invalid');
    return new URL(value, base).origin === base.origin;
  } catch {
    return false;
  }
}

export function extractDeprecations(text) {
  const source = parseTypeScript(text, 'src/config/deprecations.ts');
  const declaration = exportedVariable(source, 'routeDeprecations');
  const expression = unwrapExpression(declaration.initializer);
  if (!expression || !ts.isArrayLiteralExpression(expression)) {
    fail('routeDeprecations must be initialized with an array literal', 'DEPRECATIONS_INVALID');
  }

  const deprecations = [];
  const routes = new Set();
  for (let index = 0; index < expression.elements.length; index += 1) {
    const element = expression.elements[index];
    if (!ts.isObjectLiteralExpression(element)) {
      fail(`routeDeprecations[${index}] must be an object literal`, 'DEPRECATION_INVALID', { index });
    }

    const fields = new Map();
    for (const property of element.properties) {
      const name = propertyName(property);
      if (!name || !['route', 'sunsetDate', 'link'].includes(name)) {
        fail(`routeDeprecations[${index}] contains an unsupported or computed property`, 'DEPRECATION_PROPERTY_INVALID', {
          index,
        });
      }
      if (fields.has(name)) fail(`routeDeprecations[${index}] repeats ${name}`, 'DEPRECATION_PROPERTY_DUPLICATE', { index });
      fields.set(name, stringValue(property.initializer, `routeDeprecations[${index}].${name}`));
    }

    const route = fields.get('route');
    const sunsetDate = fields.get('sunsetDate');
    if (!route || !sunsetDate) {
      fail(`routeDeprecations[${index}] must include route and sunsetDate`, 'DEPRECATION_FIELD_MISSING', { index });
    }
    if (!route.startsWith('/')) fail(`registered deprecated route must start with "/": ${route}`, 'DEPRECATED_ROUTE_INVALID', { route });
    if (routes.has(route)) fail(`deprecated route is registered more than once: ${route}`, 'DEPRECATED_ROUTE_DUPLICATE', { route });
    routes.add(route);

    const isoDate = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(sunsetDate);
    const parsed = new Date(sunsetDate);
    if (!isoDate || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== `${isoDate[1]}T${isoDate[2]}`) {
      fail(`invalid sunset date for deprecated route ${route}; expected UTC: ${sunsetDate}`, 'DEPRECATED_SUNSET_INVALID', { route });
    }
    const link = fields.get('link');
    if (link !== undefined && !isRelativeMigrationLink(link)) {
      fail(`deprecated route ${route} must have a same-origin relative migration link`, 'DEPRECATED_LINK_INVALID', {
        route,
      });
    }
    deprecations.push({ route, sunsetDate });
  }

  return deprecations;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function resolveLocalReference(document, reference) {
  if (reference === '#') return document;
  if (!reference.startsWith('#/')) return undefined;
  let current = document;
  try {
    for (const segment of reference.slice(2).split('/')) {
      const key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(current)) {
        if (!/^\d+$/.test(key) || Number(key) >= current.length) return undefined;
        current = current[Number(key)];
      } else if (isRecord(current) && Object.hasOwn(current, key)) {
        current = current[key];
      } else {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return current;
}

function assertLocalReferences(value, document, namedMap = false) {
  if (Array.isArray(value)) {
    for (const item of value) assertLocalReferences(item, document);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (namedMap) {
      assertLocalReferences(child, document);
      continue;
    }
    if (key === '$ref') {
      if (typeof child !== 'string' || !child.startsWith('#')) {
        fail(`OpenAPI reference must be a local JSON pointer: ${String(child)}`, 'SPEC_REF_EXTERNAL');
      }
      if (resolveLocalReference(document, child) === undefined) {
        fail(`OpenAPI reference cannot be resolved: ${child}`, 'SPEC_REF_UNRESOLVED', { reference: child });
      }
      continue;
    }
    if (key === 'default' || key === 'example' || key === 'examples') continue;
    assertLocalReferences(child, document, NAMED_MAP_KEYS.has(key));
  }
}

function parseOpenApi(text, requireOperations) {
  let document;
  try {
    document = parseYaml(text, { uniqueKeys: true });
  } catch (error) {
    fail(`unable to parse OpenAPI document: ${error instanceof Error ? error.message : String(error)}`, 'SPEC_UNPARSEABLE');
  }
  if (!isRecord(document) || typeof document.openapi !== 'string' || !/^3\.\d+\.\d+$/.test(document.openapi)) {
    fail('OpenAPI document must declare a valid OpenAPI 3.x version', 'SPEC_INVALID');
  }
  if (
    !isRecord(document.info) ||
    typeof document.info.title !== 'string' ||
    typeof document.info.version !== 'string'
  ) {
    fail('OpenAPI document must contain string info.title and info.version fields', 'SPEC_INFO_INVALID');
  }
  if (!isRecord(document.paths)) fail('OpenAPI document must contain a paths object', 'SPEC_PATHS_MISSING');
  assertLocalReferences(document, document);

  const operations = new Map();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!path.startsWith('/') || /\s/.test(path)) fail(`invalid OpenAPI path: ${path}`, 'SPEC_PATH_INVALID', { path });
    if (!isRecord(pathItem)) fail(`OpenAPI path item must be an object: ${path}`, 'SPEC_PATH_ITEM_INVALID', { path });
    if (Object.hasOwn(pathItem, '$ref')) {
      fail(`OpenAPI Path Item references are unsupported: ${path}`, 'SPEC_PATH_REF_UNSUPPORTED', { path });
    }

    const pathMetadata = Object.fromEntries(
      Object.entries(pathItem).filter(([name]) => !HTTP_METHODS.has(name.toUpperCase())),
    );
    for (const [name, operation] of Object.entries(pathItem)) {
      const method = name.toUpperCase();
      if (!HTTP_METHODS.has(method)) continue;
      if (!isRecord(operation)) {
        fail(`OpenAPI operation ${method} ${path} must be an object`, 'SPEC_OPERATION_INVALID', { method, path });
      }
      if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
        fail(`OpenAPI operation ${method} ${path} must contain at least one response`, 'SPEC_RESPONSES_INVALID', {
          method,
          path,
        });
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (
          !/^(?:[1-5](?:\d{2}|XX)|default)$/.test(status) ||
          !isRecord(response) ||
          (!Object.hasOwn(response, '$ref') && typeof response.description !== 'string')
        ) {
          fail(`OpenAPI operation ${method} ${path} has an invalid response`, 'SPEC_RESPONSES_INVALID', {
            method,
            path,
            status,
          });
        }
      }
      const key = `${method} ${path}`;
      if (operations.has(key)) fail(`duplicate OpenAPI operation: ${key}`, 'SPEC_OPERATION_DUPLICATE', { key });
      operations.set(key, { pathMetadata, operation });
    }
  }

  if (requireOperations && operations.size === 0) fail('OpenAPI paths must contain at least one operation', 'SPEC_EMPTY');
  const { paths: _paths, ...withoutPaths } = document;
  return { document, operations, global: withoutPaths };
}

/** Extract the set of `METHOD path` endpoints published in `openapi.yaml`. */
export function extractSpecEndpoints(text) {
  return new Set(parseOpenApi(text, false).operations.keys());
}

/**
 * Extract every operation of `openapi.yaml` as `METHOD path → { pathMetadata,
 * operation }`. The contracts feed the release-snapshot drift checks.
 */
export function extractSpecOperations(text) {
  return parseOpenApi(text, true).operations;
}

function contractShape(value, ignoredKeys, namedMap = false) {
  if (Array.isArray(value)) return value.map((item) => contractShape(item, ignoredKeys));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => namedMap || !ignoredKeys.has(key))
      .sort()
      .map((key) => [
        key,
        contractShape(value[key], ignoredKeys, namedMap ? false : NAMED_MAP_KEYS.has(key)),
      ]),
  );
}

function contractsDiffer(before, after, ignoredKeys) {
  return JSON.stringify(contractShape(before, ignoredKeys)) !== JSON.stringify(contractShape(after, ignoredKeys));
}

/**
 * Whether a change to an operation contract is breaking for consumers.
 * Documentation-only fields (`description`, `summary`, `example`, …) never
 * break a client; everything else (schema, parameters, operationId, …) does.
 */
export function isBreakingOperationChange(before, after) {
  return contractsDiffer(before, after, CONTRACT_METADATA_KEYS);
}

function componentsDiffer(before, after, ignoredKeys) {
  if (!isRecord(before) || !isRecord(after)) return true;
  for (const [kind, beforeMap] of Object.entries(before)) {
    if (!Object.hasOwn(after, kind)) return true;
    const afterMap = after[kind];
    if (!isRecord(beforeMap) || !isRecord(afterMap)) return true;
    for (const [name, beforeComponent] of Object.entries(beforeMap)) {
      if (!Object.hasOwn(afterMap, name) || contractsDiffer(beforeComponent, afterMap[name], ignoredKeys)) return true;
    }
  }
  return false;
}

/**
 * Whether a change to the shared contract (everything outside `paths`) is
 * breaking. Document metadata such as `info` or `tags` is ignored; a change to
 * a published component schema is breaking, a newly added component is not.
 */
export function isBreakingGlobalChange(before, after) {
  const ignoredKeys = new Set([...CONTRACT_METADATA_KEYS, ...GLOBAL_METADATA_KEYS]);
  const { components: beforeComponents, ...beforeOther } = isRecord(before) ? before : {};
  const { components: afterComponents, ...afterOther } = isRecord(after) ? after : {};
  if (contractsDiffer(beforeOther, afterOther, ignoredKeys)) return true;
  if (beforeComponents === undefined) return false;
  if (afterComponents === undefined) return true;
  return componentsDiffer(beforeComponents, afterComponents, ignoredKeys);
}

function releaseEntry(spec, deprecations) {
  const operations = Object.fromEntries(
    [...spec.operations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, contract]) => [key, { fingerprint: fingerprint(contract), contract }]),
  );
  const normalizedDeprecations = [...deprecations].sort((left, right) => left.route.localeCompare(right.route));
  return {
    global: spec.global,
    globalFingerprint: fingerprint(spec.global),
    operations,
    deprecations: normalizedDeprecations,
    deprecationsFingerprint: fingerprint(normalizedDeprecations),
  };
}

/**
 * Build the release snapshot text for `versions`: the shared contract, every
 * operation, the registered deprecations, and a SHA-256 fingerprint of each so
 * a hand-edited snapshot is rejected on read.
 */
export function createReleaseSnapshot(specText, versions, deprecationsText) {
  const spec = parseOpenApi(specText, true);
  const deprecations = extractDeprecations(deprecationsText);
  const snapshot = {};
  for (const version of versions) {
    if (!/^v\d+(?:\.\d+)*$/.test(version)) fail(`invalid release version: ${version}`, 'RELEASE_VERSION_INVALID');
    snapshot[version] = releaseEntry(spec, deprecations);
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function parseReleaseSnapshot(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`unable to parse release snapshot: ${error instanceof Error ? error.message : String(error)}`, 'RELEASE_UNPARSEABLE');
  }
  if (!isRecord(document)) fail('release snapshot must be an object', 'RELEASE_INVALID');
  if (Object.keys(document).length === 0) fail('release snapshot must contain a version', 'RELEASE_EMPTY');

  for (const [version, snapshot] of Object.entries(document)) {
    if (
      !/^v\d+(?:\.\d+)*$/.test(version) ||
      !isRecord(snapshot) ||
      !isRecord(snapshot.global) ||
      !isRecord(snapshot.operations) ||
      !Array.isArray(snapshot.deprecations)
    ) {
      fail(`release snapshot contains an invalid version entry: ${version}`, 'RELEASE_INVALID', { version });
    }
    if (typeof snapshot.globalFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.globalFingerprint)) {
      fail(`release snapshot for ${version} has an invalid global fingerprint`, 'RELEASE_INVALID', { version });
    }
    if (fingerprint(snapshot.global) !== snapshot.globalFingerprint) {
      fail(`release snapshot global fingerprint does not match its contract: ${version}`, 'RELEASE_FINGERPRINT_MISMATCH', {
        version,
      });
    }
    const routes = new Set();
    for (const deprecation of snapshot.deprecations) {
      if (
        !isRecord(deprecation) ||
        typeof deprecation.route !== 'string' ||
        !deprecation.route.startsWith('/') ||
        typeof deprecation.sunsetDate !== 'string' ||
        Number.isNaN(Date.parse(deprecation.sunsetDate)) ||
        routes.has(deprecation.route)
      ) {
        fail(`release snapshot for ${version} has an invalid deprecation`, 'RELEASE_INVALID', { version });
      }
      routes.add(deprecation.route);
    }
    if (
      typeof snapshot.deprecationsFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(snapshot.deprecationsFingerprint)
    ) {
      fail(`release snapshot for ${version} has an invalid deprecations fingerprint`, 'RELEASE_INVALID', { version });
    }
    if (fingerprint(snapshot.deprecations) !== snapshot.deprecationsFingerprint) {
      fail(`release snapshot deprecations fingerprint does not match its contract: ${version}`, 'RELEASE_FINGERPRINT_MISMATCH', {
        version,
      });
    }
    for (const [key, operation] of Object.entries(snapshot.operations)) {
      if (!/^[A-Z]+\s+\/.*$/.test(key) || !isRecord(operation) || !isRecord(operation.contract)) {
        fail(`release snapshot for ${version} has an invalid operation: ${key}`, 'RELEASE_INVALID', { version, key });
      }
      if (typeof operation.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(operation.fingerprint)) {
        fail(`release snapshot for ${version} has an invalid operation fingerprint: ${key}`, 'RELEASE_INVALID', { version, key });
      }
      if (fingerprint(operation.contract) !== operation.fingerprint) {
        fail(`release snapshot fingerprint does not match its contract: ${version} ${key}`, 'RELEASE_FINGERPRINT_MISMATCH', { version, key });
      }
    }
  }
  return document;
}

function updateReleaseSnapshot(existingText, specText, deprecationsText, version) {
  const current = existingText.trim() === '' ? {} : parseReleaseSnapshot(existingText);
  current[version] = releaseEntry(parseOpenApi(specText, true), extractDeprecations(deprecationsText));
  return `${JSON.stringify(current, null, 2)}\n`;
}

/**
 * Derive the set of endpoints the changelog declares as currently live.
 * Sections are parsed newest first, so the first `Added` / `Removed` entry seen
 * for a scope decides its state.
 */
export function deriveLiveEndpoints(sections) {
  const state = new Map();
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.scope === GLOBAL_SCOPE || (entry.kind !== 'Added' && entry.kind !== 'Removed')) continue;
      const key = `${entry.method} ${entry.path}`;
      if (!state.has(key)) state.set(key, entry.kind === 'Removed' ? 'removed' : 'live');
    }
  }
  return new Set([...state.entries()].filter(([, status]) => status === 'live').map(([key]) => key));
}

function sunsetDatePart(iso) {
  return /^(\d{4}-\d{2}-\d{2})/.exec(iso)?.[1] ?? null;
}

function hasHeadEntry(sections, scope, kinds) {
  return sections[0]?.entries.some((entry) => entry.scope === scope && kinds.includes(entry.kind)) ?? false;
}

function releaseChecks(sections, spec, registeredDeprecations, releaseText, allowReleaseDrift, errors) {
  let releases;
  try {
    releases = parseReleaseSnapshot(releaseText);
  } catch (error) {
    errors.push(error.message);
    return;
  }

  const version = sections[0]?.version;
  let previous = version ? releases[version] : undefined;
  if (!previous) {
    if (!allowReleaseDrift) {
      errors.push(`release snapshot is missing API version ${version ?? '(unknown)'}`);
      return;
    }
    const priorVersion = sections.slice(1).find((section) => releases[section.version])?.version;
    if (priorVersion) {
      previous = releases[priorVersion];
    } else {
      if (Object.keys(releases).length > 0) {
        errors.push(`release snapshot has no prior contract for API version ${version ?? '(unknown)'}`);
      }
      return;
    }
  }

  const currentOperations = Object.fromEntries(
    [...spec.operations.entries()].map(([key, contract]) => [key, { fingerprint: fingerprint(contract), contract }]),
  );
  const previousKeys = new Set(Object.keys(previous.operations));
  const currentKeys = new Set(Object.keys(currentOperations));
  for (const key of currentKeys) {
    if (!previousKeys.has(key)) {
      if (!hasHeadEntry(sections, key, ['Added'])) errors.push(`operation ${key} is new but has no Added entry in ${version}`);
      continue;
    }
    const before = previous.operations[key].contract;
    const after = currentOperations[key].contract;
    if (fingerprint(before) === fingerprint(after)) continue;

    const breaking = isBreakingOperationChange(before, after);
    const kinds = ['Changed', 'Fixed'];
    if (!hasHeadEntry(sections, key, kinds)) {
      errors.push(`operation ${key} changed but has no Changed or Fixed entry in ${version}`);
      continue;
    }
    const matching = sections[0].entries.filter((entry) => entry.scope === key && kinds.includes(entry.kind));
    const marked = matching.some((entry) => entry.breaking);
    if (breaking && !marked) errors.push(`breaking operation change ${key} must be marked ${BREAKING_MARKER} in ${version}`);
    if (!breaking && marked) errors.push(`non-breaking operation change ${key} must not be marked ${BREAKING_MARKER}`);
  }
  for (const key of previousKeys) {
    if (!currentKeys.has(key) && !hasHeadEntry(sections, key, ['Removed'])) {
      errors.push(`operation ${key} was removed but has no Removed entry in ${version}`);
    }
  }

  const currentDeprecations = [...registeredDeprecations].sort((left, right) => left.route.localeCompare(right.route));
  const previousDeprecations = new Map(previous.deprecations.map((deprecation) => [deprecation.route, deprecation]));
  for (const deprecation of currentDeprecations) {
    const before = previousDeprecations.get(deprecation.route);
    if (before?.sunsetDate === deprecation.sunsetDate) continue;
    const scope = `${DEPRECATED_METHOD} ${deprecation.route}`;
    if (!hasHeadEntry(sections, scope, ['Deprecated'])) {
      errors.push(`deprecation for ${deprecation.route} was added or changed but has no Deprecated entry in ${version}`);
    }
  }
  for (const deprecation of previousDeprecations.values()) {
    if (currentDeprecations.some((candidate) => candidate.route === deprecation.route)) continue;
    const scope = `${DEPRECATED_METHOD} ${deprecation.route}`;
    if (!hasHeadEntry(sections, scope, ['Changed', 'Fixed'])) {
      errors.push(`deprecation for ${deprecation.route} was removed but has no Changed or Fixed entry in ${version}`);
    }
  }

  const currentGlobalFingerprint = fingerprint(spec.global);
  if (currentGlobalFingerprint !== previous.globalFingerprint) {
    const kinds = ['Added', 'Changed', 'Fixed'];
    if (!hasHeadEntry(sections, GLOBAL_SCOPE, kinds)) {
      errors.push(`shared API contract changed but has no * entry in ${version}`);
    } else {
      const marked = sections[0].entries.some(
        (entry) => entry.scope === GLOBAL_SCOPE && kinds.includes(entry.kind) && entry.breaking,
      );
      const breaking = isBreakingGlobalChange(previous.global, spec.global);
      if (breaking && !marked) errors.push(`breaking shared API contract change must be marked ${BREAKING_MARKER} in ${version}`);
      if (!breaking && marked) errors.push(`non-breaking shared API contract change must not be marked ${BREAKING_MARKER}`);
    }
  }
  if (!allowReleaseDrift && currentGlobalFingerprint !== previous.globalFingerprint) {
    errors.push(`release snapshot for ${version} is stale; run pnpm run update:api-changelog`);
  }
  if (!allowReleaseDrift && fingerprint(currentOperations) !== fingerprint(previous.operations)) {
    errors.push(`release snapshot for ${version} is stale; run pnpm run update:api-changelog`);
  }
  if (!allowReleaseDrift && fingerprint(currentDeprecations) !== previous.deprecationsFingerprint) {
    errors.push(`release deprecations for ${version} are stale; run pnpm run update:api-changelog`);
  }
}

/**
 * Run every changelog invariant against in-memory documents. Returns
 * `{ errors, summary }`; an empty `errors` array means the changelog is
 * consistent with the API surface and the released contract.
 *
 * `allowReleaseDrift` is set by `--update-release`: "snapshot is stale" errors
 * are suppressed so the snapshot can be rewritten, while the entries that drift
 * requires are still enforced against the previously released contract.
 */
export function runChecks({
  changelogText,
  specText,
  apiVersionText,
  deprecationsText,
  releaseText,
  allowReleaseDrift = false,
}) {
  const errors = [];
  let sections;
  try {
    ({ sections } = parseChangelog(changelogText));
  } catch (error) {
    return { errors: [error.message], summary: 'changelog could not be parsed' };
  }

  let supported = [];
  let defaultVersion = null;
  try {
    ({ supported, defaultVersion } = extractApiVersions(apiVersionText));
  } catch (error) {
    errors.push(error.message);
  }

  let registeredDeprecations = [];
  try {
    registeredDeprecations = extractDeprecations(deprecationsText);
  } catch (error) {
    errors.push(error.message);
  }

  let spec;
  try {
    spec = parseOpenApi(specText, true);
  } catch (error) {
    errors.push(error.message);
    spec = { operations: new Map(), global: {} };
  }
  const specEndpoints = new Set(spec.operations.keys());
  const liveEndpoints = deriveLiveEndpoints(sections);
  const sectionVersions = new Set(sections.map((section) => section.version));

  for (const version of supported) {
    if (!sectionVersions.has(version)) errors.push(`API version ${version} is served (SUPPORTED_VERSIONS) but has no changelog section`);
  }
  if (supported.length > 0 && !supported.includes(defaultVersion)) {
    errors.push(`DEFAULT_API_VERSION ${defaultVersion} is not served`);
  }
  if (!supported.includes(sections[0].version)) {
    errors.push(`first changelog section is ${sections[0].version}, but SUPPORTED_VERSIONS = [${supported.join(', ')}]`);
  }

  for (const [sectionIndex, section] of sections.entries()) {
    const isHeadSection = sectionIndex === 0;
    for (const entry of section.entries) {
      if (entry.kind === 'Deprecated' && entry.scope === GLOBAL_SCOPE) {
        errors.push('deprecations must name a route (`ALL /path`), not the global `*` scope');
      }
      if (
        entry.scope !== GLOBAL_SCOPE &&
        !HTTP_METHODS.has(entry.method) &&
        !(entry.method === DEPRECATED_METHOD && (entry.kind === 'Deprecated' || entry.kind === 'Changed'))
      ) {
        errors.push(`entry \`${entry.scope}\` must use a concrete HTTP method (${[...HTTP_METHODS].join(', ')}), not \`${entry.method}\``);
      }
      if (entry.kind === 'Deprecated' && entry.method !== DEPRECATED_METHOD) {
        errors.push(`deprecation entry \`${entry.scope}\` must use method ${DEPRECATED_METHOD} (a deprecation covers every method of the route)`);
      }

      const key = entry.scope === GLOBAL_SCOPE ? null : `${entry.method} ${entry.path}`;
      if (isHeadSection && entry.kind === 'Added' && key && !specEndpoints.has(key)) {
        errors.push(`scope \`${entry.scope}\` is recorded as Added but does not exist in openapi.yaml — add the endpoint to the spec or mark the change correctly`);
      }
      if (
        isHeadSection &&
        (entry.kind === 'Changed' || entry.kind === 'Fixed') &&
        key &&
        entry.method !== DEPRECATED_METHOD &&
        !specEndpoints.has(key)
      ) {
        errors.push(`scope \`${entry.scope}\` is recorded as ${entry.kind} but does not exist in openapi.yaml`);
      }
      if (isHeadSection && entry.kind === 'Removed' && key && specEndpoints.has(key)) {
        errors.push(`scope \`${entry.scope}\` is recorded as Removed but still exists in openapi.yaml — remove it from the spec or keep the record live`);
      }
      if (entry.kind === 'Removed' && !entry.breaking) errors.push(`removal \`${entry.scope}\` must be marked ${BREAKING_MARKER}`);
      if (entry.breaking && (entry.kind === 'Added' || entry.kind === 'Deprecated')) {
        errors.push(`entry \`${entry.scope}\` (${entry.kind}) must not carry the ${BREAKING_MARKER} marker`);
      }
    }
  }

  for (const key of [...liveEndpoints].sort()) {
    if (!specEndpoints.has(key)) errors.push(`endpoint ${key} is recorded as live in the changelog but is not present in openapi.yaml`);
  }
  for (const key of [...specEndpoints].sort()) {
    if (!liveEndpoints.has(key)) errors.push(`endpoint ${key} exists in openapi.yaml but has no live changelog entry — record its addition`);
  }

  const deprecatedEntries = sections.flatMap((section) => section.entries.filter((entry) => entry.kind === 'Deprecated'));
  for (const deprecation of registeredDeprecations) {
    const matches = deprecatedEntries.filter((entry) => entry.path === deprecation.route);
    if (matches.length === 0) {
      errors.push(`deprecated route ${deprecation.route} is registered in src/config/deprecations.ts but has no changelog entry`);
      continue;
    }
    const date = sunsetDatePart(deprecation.sunsetDate);
    if (date && !matches.some((entry) => entry.description.includes(date))) {
      errors.push(`the changelog entry for ${deprecation.route} must mention its sunset date ${date}`);
    }
  }
  for (const entry of sections[0].entries.filter((candidate) => candidate.kind === 'Deprecated')) {
    if (!registeredDeprecations.some((deprecation) => deprecation.route === entry.path)) {
      errors.push(`changelog marks ${entry.scope} deprecated but it is not registered in src/config/deprecations.ts`);
    }
  }

  if (releaseText !== undefined && (!allowReleaseDrift || releaseText.trim() !== '')) {
    releaseChecks(sections, spec, registeredDeprecations, releaseText, allowReleaseDrift, errors);
  }

  const served = supported.length > 0 ? supported.join(', ') : '(none parsed)';
  const summary = errors.length === 0
    ? `${sections.length} version section(s), ${liveEndpoints.size} live endpoint(s), ${registeredDeprecations.length} deprecation(s).`
    : `${sections.length} version section(s) for served versions [${served}]; ${errors.length} problem(s) found.`;
  return { errors, summary };
}

/**
 * Run the check against real files. Any missing or unreadable file is a
 * failure — the check must never silently skip a source of truth. The release
 * snapshot may be absent only while `allowReleaseDrift` bootstraps it.
 */
export function checkProject({
  changelogPath,
  specPath,
  apiVersionPath,
  deprecationsPath,
  releasePath,
  allowReleaseDrift = false,
}) {
  const errors = [];
  const files = { changelogPath, specPath, apiVersionPath, deprecationsPath };
  if (releasePath && (!allowReleaseDrift || fs.existsSync(releasePath))) files.releasePath = releasePath;
  for (const [name, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) errors.push(`required file is missing: ${filePath} (${name})`);
  }
  if (errors.length > 0) return { errors, summary: `${errors.length} problem(s) found.` };

  try {
    return runChecks({
      changelogText: fs.readFileSync(changelogPath, 'utf8'),
      specText: fs.readFileSync(specPath, 'utf8'),
      apiVersionText: fs.readFileSync(apiVersionPath, 'utf8'),
      deprecationsText: fs.readFileSync(deprecationsPath, 'utf8'),
      releaseText: releasePath && fs.existsSync(releasePath) ? fs.readFileSync(releasePath, 'utf8') : undefined,
      allowReleaseDrift,
    });
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], summary: '1 problem found.' };
  }
}

/** Render a result as one success line, or a failure header plus bullets. */
export function formatResult(result) {
  if (result.errors.length === 0) return `API changelog check passed: ${result.summary}`;
  return [`API changelog check failed: ${result.summary}`, ...result.errors.map((error) => `  - ${error}`)].join('\n');
}

/**
 * Parse CLI flags into absolute paths. Unknown flags and missing values fail
 * closed so a typo can never quietly run the check against the wrong file.
 */
export function parseCliArgs(argv, cwd) {
  const options = {
    changelogPath: path.resolve(cwd, DEFAULT_PATHS.changelog),
    specPath: path.resolve(cwd, DEFAULT_PATHS.spec),
    apiVersionPath: path.resolve(cwd, DEFAULT_PATHS.apiVersion),
    deprecationsPath: path.resolve(cwd, DEFAULT_PATHS.deprecations),
    releasePath: path.resolve(cwd, DEFAULT_PATHS.release),
    updateRelease: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') continue;
    if (flag === '--update-release') {
      options.updateRelease = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`, 'CLI_FLAG_MISSING_VALUE');
    const key = flag.replace(/^--/, '');
    const pathKey = ARG_KEY_TO_PATH_KEY[key];
    if (!pathKey) fail(`unrecognized flag ${flag}`, 'CLI_FLAG_UNKNOWN');
    options[pathKey] = path.resolve(cwd, value);
    index += 1;
  }
  return options;
}

/**
 * CLI entry point: returns `0` on success and `1` on any failure, writing the
 * formatted result to stdout (pass) or stderr (fail). `--update-release`
 * rewrites `docs/api/releases.json` for the head section once the checks pass.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const options = parseCliArgs(argv, cwd);
    const result = checkProject({ ...options, allowReleaseDrift: options.updateRelease });
    const output = formatResult(result);
    if (result.errors.length > 0) {
      process.stderr.write(`${output}\n`);
      return 1;
    }

    if (options.updateRelease) {
      const { sections } = parseChangelog(fs.readFileSync(options.changelogPath, 'utf8'));
      const version = sections[0].version;
      const specText = fs.readFileSync(options.specPath, 'utf8');
      const deprecationsText = fs.readFileSync(options.deprecationsPath, 'utf8');
      const existing = fs.existsSync(options.releasePath) ? fs.readFileSync(options.releasePath, 'utf8') : '';
      fs.writeFileSync(options.releasePath, updateReleaseSnapshot(existing, specText, deprecationsText, version));
      process.stdout.write(`Updated API release snapshot for ${version}.\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`API changelog check failed: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
