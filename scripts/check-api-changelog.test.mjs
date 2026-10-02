import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangelogError,
  DEFAULT_PATHS,
  checkProject,
  createReleaseSnapshot,
  deriveLiveEndpoints,
  extractApiVersions,
  extractDeprecations,
  extractSpecEndpoints,
  extractSpecOperations,
  formatResult,
  isBreakingGlobalChange,
  isBreakingOperationChange,
  main,
  parseChangelog,
  runChecks,
} from './check-api-changelog.mjs';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function apiVersionFixture(supported = ['v1'], defaultVersion = supported[0] ?? 'v1') {
  return [
    `export const SUPPORTED_VERSIONS: readonly string[] = ${JSON.stringify(supported)};`,
    `export const DEFAULT_API_VERSION = '${defaultVersion}';`,
    '',
  ].join('\n');
}

function deprecationsFixture(deprecations = []) {
  const items = deprecations.map(
    ({ route, sunsetDate }) => `  {
    route: '${route}',
    sunsetDate: '${sunsetDate}',
    link: '/docs/api/deprecation-policy.md',
  },`,
  );
  return [
    "import { DeprecatedRoute } from '../middleware/deprecation.ts';",
    'export const routeDeprecations: readonly DeprecatedRoute[] = [',
    items.join('\n'),
    '];',
    '',
  ].join('\n');
}

function specFixture(endpoints) {
  const lines = ['openapi: 3.1.0', 'info:', '  title: test', '  version: test', 'paths:'];
  for (const [entryPath, methods] of Object.entries(endpoints)) {
    lines.push(`  ${entryPath}:`);
    for (const method of methods) {
      lines.push(
        `    ${method.toLowerCase()}:`,
        '      responses:',
        "        '200':",
        '          description: OK',
      );
    }
  }
  lines.push('components:');
  lines.push('  securitySchemes:');
  lines.push('    bearer:');
  lines.push('      type: http');
  return `${lines.join('\n')}\n`;
}

function contractSpecFixture({
  descriptionType = 'string',
  includeGone = false,
  includeNew = false,
  includePost = true,
  infoVersion = 'test',
  operationId = 'getHello',
  operationSummary = 'Original summary',
  valueType = 'string',
} = {}) {
  const lines = [
    'openapi: 3.1.0',
    'info:',
    '  title: test',
    `  version: ${infoVersion}`,
    'paths:',
    '  /api/hello:',
    '    get:',
    `      summary: ${operationSummary}`,
    `      operationId: ${operationId}`,
    '      responses:',
    "        '200':",
    '          description: OK',
    '          content:',
    '            application/json:',
    '              schema:',
    "                $ref: '#/components/schemas/Hello'",
  ];
  if (includePost) {
    lines.push(
      '    post:',
      '      summary: Original post summary',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema:',
      "                $ref: '#/components/schemas/Hello'",
    );
  }
  if (includeNew) {
    lines.push(
      '  /api/new:',
      '    get:',
      '      summary: New endpoint',
      '      responses:',
      "        '200':",
      '          description: OK',
    );
  }
  if (includeGone) {
    lines.push(
      '  /api/gone:',
      '    get:',
      '      summary: Historical endpoint',
      '      responses:',
      "        '200':",
      '          description: OK',
    );
  }
  lines.push(
    'components:',
    '  schemas:',
    '    Hello:',
    '      type: object',
    '      required:',
    '        - value',
    '      properties:',
    '        value:',
    `          type: ${valueType}`,
    '        description:',
    `          type: ${descriptionType}`,
  );
  return `${lines.join('\n')}\n`;
}

const defaultSpec = {
  '/api/hello': ['GET', 'POST'],
};

const happyChangelog = `# Test

Some prose about the changelog.

## v1

### Added

- \`*\` — Version negotiation via the \`Accept-Version\` header.
- \`GET /api/hello\` — A test endpoint.
- \`POST /api/hello\` — Another test endpoint.

### Deprecated

- \`ALL /api/rate-limits/config\` — Planned removal on 2026-09-30.

### Removed

- \`GET /api/gone\` [breaking] — Removed from v1.
`;

const happyDeprecations = [{ route: '/api/rate-limits/config', sunsetDate: '2026-09-30T00:00:00.000Z' }];
const happyDeprecationsText = deprecationsFixture(happyDeprecations);
const defaultSpecText = specFixture(defaultSpec);
const defaultReleaseText = createReleaseSnapshot(defaultSpecText, ['v1'], happyDeprecationsText);

function versionedChangelog(entries, previous = happyChangelog) {
  const previousIndex = previous.indexOf('## v1');
  return `## v2\n\n${entries}\n\n${previous.slice(previousIndex)}`;
}

function historicalChangelog() {
  return happyChangelog
    .replace('### Deprecated', '- `GET /api/gone` — Historical endpoint.\n\n### Deprecated')
    .replace(/\n### Removed\n\n- `GET \/api\/gone` \[breaking\] — Removed from v1\.\n/, '\n');
}

function versionedChecks({
  allowReleaseDrift = true,
  baseline = contractSpecFixture(),
  changelogText,
  current = baseline,
  deprecationsText = happyDeprecationsText,
  releaseText = createReleaseSnapshot(baseline, ['v2'], happyDeprecationsText),
}) {
  return runChecks({
    changelogText,
    specText: current,
    apiVersionText: apiVersionFixture(['v1', 'v2'], 'v2'),
    deprecationsText,
    releaseText,
    allowReleaseDrift,
  });
}

function happyChecks(overrides = {}) {
  return runChecks({
    changelogText: overrides.changelogText ?? happyChangelog,
    specText: overrides.specText ?? specFixture(overrides.spec ?? defaultSpec),
    apiVersionText: overrides.apiVersionText ?? apiVersionFixture(),
    deprecationsText: overrides.deprecationsText ?? deprecationsFixture(happyDeprecations),
    releaseText: overrides.releaseText ?? defaultReleaseText,
    allowReleaseDrift: overrides.allowReleaseDrift ?? false,
  });
}

describe('parseChangelog', () => {
  it('parses sections and entries', () => {
    const { sections } = parseChangelog(happyChangelog);
    expect(sections.map((section) => section.version)).toEqual(['v1']);
    expect(sections[0].entries.map((entry) => entry.kind)).toEqual(['Added', 'Added', 'Added', 'Deprecated', 'Removed']);
    expect(sections[0].entries.find((entry) => entry.path === '/api/gone')).toMatchObject({
      method: 'GET',
      breaking: true,
    });
    expect(sections[0].entries.find((entry) => entry.scope === '*')).toMatchObject({
      method: '*',
      path: '*',
      breaking: false,
    });
  });

  it('requires newest sections first', () => {
    const doc = '## v1\n\n## v2\n\n### Added\n\n- `GET /api/hello` — second.\n';
    expect(() => parseChangelog(doc)).toThrowError(/newest first/);
  });

  it('rejects duplicate version sections', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello` — one.\n\n## v1\n\n### Added\n\n- `GET /api/hello` — two.\n';
    expect(() => parseChangelog(doc)).toThrowError(/duplicate section/);
  });

  it('rejects unknown change groups', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello` — one.\n\n### Improved\n\n- `GET /api/hello` — two.\n';
    expect(() => parseChangelog(doc)).toThrowError(/unknown change group/);
  });

  it('rejects entry bullets inside a section but outside a change group', () => {
    const doc = '## v1\n\n- `GET /api/hello` — misplaced entry.\n';
    expect(() => parseChangelog(doc)).toThrowError(/outside of a version section and change group/);
  });

  it('ignores preamble documentation before the first version section', () => {
    const doc = '# API Changelog\n\n## Scope\n\n- `GET /api/streams` — an example scope.\n\n## v1\n\n### Added\n\n- `GET /api/hello` — real entry.\n';
    const { sections } = parseChangelog(doc);
    expect(sections.map((section) => section.version)).toEqual(['v1']);
    expect(sections[0].entries).toHaveLength(1);
  });

  it('rejects invalid scope tokens', () => {
    const doc = '## v1\n\n### Added\n\n- `GET` — no path.\n';
    expect(() => parseChangelog(doc)).toThrowError(/invalid scope token/);
  });

  it('rejects missing descriptions', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello`\n';
    expect(() => parseChangelog(doc)).toThrowError(/description/);
  });

  it('rejects headings deeper than ###', () => {
    const doc = '## v1\n\n### Added\n\n#### In depth\n';
    expect(() => parseChangelog(doc)).toThrowError(/only/);
  });

  it('rejects duplicate scopes within one version', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello` — one.\n\n### Changed\n\n- `GET /api/hello` — two.\n';
    expect(() => parseChangelog(doc)).toThrowError(/duplicate entry for scope/);
  });

  it('accepts the OpenAPI root path as a scope', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /` — Service metadata.\n';
    expect(parseChangelog(doc).sections[0].entries[0]).toMatchObject({ method: 'GET', path: '/' });
  });
});

describe('extractApiVersions', () => {
  it('parses supported versions and default', () => {
    const { supported, defaultVersion } = extractApiVersions(apiVersionFixture(['v1', 'v2']));
    expect(supported).toEqual(['v1', 'v2']);
    expect(defaultVersion).toBe('v1');
  });

  it('fails closed when the declaration changes shape', () => {
    expect(() => extractApiVersions('export const SUPPORTED_VERSIONS = ["v1"];')).toThrowError(/unable to locate/);
  });

  it('rejects non-version values', () => {
    expect(() => extractApiVersions(apiVersionFixture(['v1', 'unstable']))).toThrowError(/not an API version/);
  });

  it('rejects duplicate supported versions', () => {
    expect(() => extractApiVersions(apiVersionFixture(['v1', 'v1']))).toThrowError(/must not contain duplicates/);
  });

  it('rejects an unsupported default version', () => {
    expect(() => extractApiVersions(apiVersionFixture(['v1'], 'v2'))).toThrowError(/not present in SUPPORTED_VERSIONS/);
  });

  it('fails closed on malformed TypeScript', () => {
    const text = 'export const SUPPORTED_VERSIONS = ["v1";\nexport const DEFAULT_API_VERSION = "v1";';
    expect(() => extractApiVersions(text)).toThrowError(/unable to parse/);
  });
});

describe('extractDeprecations', () => {
  it('parses route and sunset date pairs in order', () => {
    const deprecations = [
      { route: '/api/a', sunsetDate: '2026-09-30T00:00:00.000Z' },
      { route: '/api/b', sunsetDate: '2027-01-01T00:00:00.000Z' },
    ];
    expect(extractDeprecations(deprecationsFixture(deprecations))).toEqual(deprecations);
  });

  it('fails closed when the registry cannot be found', () => {
    expect(() => extractDeprecations('export const others = [];')).toThrowError(/unable to locate/);
  });

  it('rejects an unparseable sunset date', () => {
    const text = deprecationsFixture([{ route: '/api/a', sunsetDate: 'not-a-date' }]);
    expect(() => extractDeprecations(text)).toThrowError(/invalid sunset date/);
  });

  it('rejects duplicate deprecated routes', () => {
    const text = deprecationsFixture([
      { route: '/api/a', sunsetDate: '2026-09-30T00:00:00.000Z' },
      { route: '/api/a', sunsetDate: '2027-09-30T00:00:00.000Z' },
    ]);
    expect(() => extractDeprecations(text)).toThrowError(/registered more than once/);
  });

  it('rejects non-literal deprecation fields', () => {
    const text = deprecationsFixture([{ route: '/api/a', sunsetDate: '2026-09-30T00:00:00.000Z' }]).replace(
      "route: '/api/a'",
      'route: routeName',
    );
    expect(() => extractDeprecations(text)).toThrowError(/must be a string literal/);
  });

  it('rejects external and protocol-relative migration links', () => {
    const text = deprecationsFixture([{ route: '/api/a', sunsetDate: '2026-09-30T00:00:00.000Z' }]);
    expect(() => extractDeprecations(text.replace("'/docs/api/deprecation-policy.md'", "'//evil.example'"))).toThrowError(
      /same-origin relative migration link/,
    );
    expect(() => extractDeprecations(text.replace("'/docs/api/deprecation-policy.md'", "'https://evil.example'"))).toThrowError(
      /same-origin relative migration link/,
    );
  });
});

describe('extractSpecEndpoints', () => {
  it('extracts methods and paths', () => {
    const endpoints = extractSpecEndpoints(specFixture({ '/api/hello': ['GET', 'POST'], '/api/bye/{id}': ['DELETE'] }));
    expect([...endpoints].sort()).toEqual(['DELETE /api/bye/{id}', 'GET /api/hello', 'POST /api/hello']);
  });

  it('ignores non-path sections and comments', () => {
    const text = [
      'openapi: 3.1.0',
      '# leading comment',
      'info:',
      '  title: test',
      '  version: test',
      'paths:',
      '  # a commented-out path',
      '  /api/hello:',
      '    # a commented-out method',
      '    hum:',
      'components:',
      '  schemas:',
      '    Thing:',
      '      type: object',
    ].join('\n');
    expect([...extractSpecEndpoints(text)]).toEqual([]);
  });

  it('accepts the root path', () => {
    expect([...extractSpecEndpoints(specFixture({ '/': ['GET'] }))]).toEqual(['GET /']);
  });

  it('rejects malformed and empty OpenAPI documents', () => {
    expect(() => extractSpecOperations('openapi: 3.1.0\ninfo:\n  title: test\n')).toThrowError(
      /info.title and info.version/,
    );
    expect(() =>
      extractSpecOperations('openapi: 3.1.0\ninfo:\n  title: test\n  version: test\n'),
    ).toThrowError(/paths object/);
    expect(() =>
      extractSpecOperations('openapi: 3.1.0\ninfo:\n  title: test\n  version: test\npaths: {}\n'),
    ).toThrowError(/at least one operation/);
    expect(() => extractSpecOperations('openapi: 3.1.0\nopenapi: 3.0.3\npaths: {}\n')).toThrowError(
      /unable to parse/,
    );
    expect(() =>
      extractSpecOperations('openapi: 3.invalid\ninfo:\n  title: test\n  version: test\npaths: {}\n'),
    ).toThrowError(/valid OpenAPI 3.x version/);
  });

  it('rejects invalid Operation Objects', () => {
    const header = 'openapi: 3.1.0\ninfo:\n  title: test\n  version: test\npaths:\n  /api/hello:\n';
    expect(() => extractSpecOperations(`${header}    get:\n`)).toThrowError(/must be an object/);
    expect(() => extractSpecOperations(`${header}    get: {}\n`)).toThrowError(/at least one response/);
    expect(() =>
      extractSpecOperations(`${header}    get:\n      responses:\n        '200': null\n`),
    ).toThrowError(/invalid response/);
    expect(() =>
      extractSpecOperations(`${header}    get:\n      responses:\n        '200': {}\n`),
    ).toThrowError(/invalid response/);
  });

  it('rejects unsupported or unresolved references', () => {
    const header = 'openapi: 3.1.0\ninfo:\n  title: test\n  version: test\npaths:\n  /api/hello:\n';
    expect(() =>
      extractSpecOperations(
        `${header}    get:\n      responses:\n        '200':\n          description: OK\n          content:\n            application/json:\n              schema:\n                $ref: 'https://example.com/schema.yaml'\n`,
      ),
    ).toThrowError(/must be a local JSON pointer/);
    expect(() =>
      extractSpecOperations(
        `${header}    get:\n      responses:\n        '200':\n          description: OK\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Missing'\n`,
      ),
    ).toThrowError(/cannot be resolved/);
    expect(() =>
      extractSpecOperations(
        `openapi: 3.1.0\ninfo:\n  title: test\n  version: test\npaths:\n  /api/hello:\n    $ref: '#/components/pathItems/Hello'\ncomponents:\n  pathItems:\n    Hello:\n      get:\n        responses:\n          '200':\n            description: OK\n`,
      ),
    ).toThrowError(/Path Item references are unsupported/);
  });
});

describe('release snapshots', () => {
  it('creates a deterministic snapshot of operations and shared contracts', () => {
    const first = createReleaseSnapshot(contractSpecFixture(), ['v2', 'v1'], happyDeprecationsText);
    const second = createReleaseSnapshot(contractSpecFixture(), ['v2', 'v1'], happyDeprecationsText);
    const snapshot = JSON.parse(first);

    expect(first).toBe(second);
    expect(Object.keys(snapshot)).toEqual(['v2', 'v1']);
    expect(Object.keys(snapshot.v2.operations)).toEqual(['GET /api/hello', 'POST /api/hello']);
    expect(snapshot.v2.global.info.version).toBe('test');
    expect(snapshot.v2.globalFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.v2.deprecations).toEqual(happyDeprecations);
    expect(snapshot.v2.deprecationsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid snapshot versions', () => {
    expect(() => createReleaseSnapshot(contractSpecFixture(), ['stable'], happyDeprecationsText)).toThrowError(
      /invalid release version/,
    );
  });

  it('treats operation documentation as non-breaking and generated names as breaking', () => {
    const before = extractSpecOperations(contractSpecFixture()).get('GET /api/hello');
    const documentation = structuredClone(before);
    documentation.operation.summary = 'Updated summary';
    expect(isBreakingOperationChange(before, documentation)).toBe(false);

    const generatedName = structuredClone(before);
    generatedName.operation.operationId = 'renamedHello';
    expect(isBreakingOperationChange(before, generatedName)).toBe(true);
  });

  it('ignores global documentation but detects named-map schema fields', () => {
    const snapshot = JSON.parse(createReleaseSnapshot(contractSpecFixture(), ['v1'], happyDeprecationsText)).v1;
    const documentation = structuredClone(snapshot.global);
    documentation.info.version = '2.0.0';
    expect(isBreakingGlobalChange(snapshot.global, documentation)).toBe(false);

    const schema = structuredClone(snapshot.global);
    schema.components.schemas.Hello.properties.description.type = 'number';
    expect(isBreakingGlobalChange(snapshot.global, schema)).toBe(true);

    const definitions = structuredClone(snapshot.global);
    definitions.components.schemas.Hello.$defs = { description: { type: 'object' } };
    definitions.components.schemas.Hello.$defs.description.type = 'string';
    expect(isBreakingGlobalChange(snapshot.global, definitions)).toBe(true);

    const addition = structuredClone(snapshot.global);
    addition.components.schemas.NewResponse = { type: 'object' };
    expect(isBreakingGlobalChange(snapshot.global, addition)).toBe(false);

    const requiredField = structuredClone(snapshot.global);
    requiredField.components.schemas.Hello.required.push('optional');
    expect(isBreakingGlobalChange(snapshot.global, requiredField)).toBe(true);
  });

  it('rejects a snapshot whose global fingerprint was tampered with', () => {
    const snapshot = JSON.parse(defaultReleaseText);
    snapshot.v1.globalFingerprint = '0'.repeat(64);
    const result = happyChecks({ releaseText: JSON.stringify(snapshot) });
    expect(result.errors.join('\n')).toMatch(/global fingerprint does not match/);
  });

  it('rejects a snapshot whose operation fingerprint was tampered with', () => {
    const snapshot = JSON.parse(defaultReleaseText);
    snapshot.v1.operations['GET /api/hello'].fingerprint = '0'.repeat(64);
    const result = happyChecks({ releaseText: JSON.stringify(snapshot) });
    expect(result.errors.join('\n')).toMatch(/fingerprint does not match its contract.*GET \/api\/hello/);
  });

  it('rejects a snapshot whose deprecations fingerprint was tampered with', () => {
    const snapshot = JSON.parse(defaultReleaseText);
    snapshot.v1.deprecationsFingerprint = '0'.repeat(64);
    const result = happyChecks({ releaseText: JSON.stringify(snapshot) });
    expect(result.errors.join('\n')).toMatch(/deprecations fingerprint does not match/);
  });
});

describe('deriveLiveEndpoints', () => {
  it('resolves state newest first, removal wins', () => {
    const { sections } = parseChangelog([
      '## v2',
      '',
      '### Removed',
      '',
      '- `GET /api/hello` [breaking] — retired.',
      '',
      '### Added',
      '',
      '- `GET /api/world` — new.',
      '',
      '## v1',
      '',
      '### Added',
      '',
      '- `GET /api/hello` — added.',
    ].join('\n'));
    expect([...deriveLiveEndpoints(sections)].sort()).toEqual(['GET /api/world']);
  });
});

describe('runChecks', () => {
  it('passes for a consistent changelog', () => {
    const result = happyChecks();
    expect(result.errors).toEqual([]);
  });

  it('requires a changelog entry when an endpoint is added to the spec', () => {
    const result = happyChecks({ spec: { ...defaultSpec, '/api/hello': ['GET'], '/api/other': ['POST'] } });
    expect(result.errors.join('\n')).toMatch(/POST \/api\/other.*no live changelog entry/);
  });

  it('rejects Added entries for endpoints absent from the spec', () => {
    const changelogText = `${happyChangelog}\n### Changed\n\n- \`GET /api/missing\` — mystery endpoint.\n\n`;
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/GET \/api\/missing/);
  });

  it('rejects removal records without an explicit breaking marker', () => {
    const changelogText = happyChangelog.replace('- `GET /api/gone` [breaking]', '- `GET /api/gone`');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/must be marked \[breaking\]/);
  });

  it('rejects a removal while the endpoint still exists in the spec', () => {
    const result = happyChecks({ spec: { ...defaultSpec, '/api/gone': ['GET'] } });
    expect(result.errors.join('\n')).toMatch(/recorded as Removed but still exists/);
  });

  it('forbids the breaking marker on Added and Deprecated entries', () => {
    const changelogText = happyChangelog.replace('- `*` — Version', '- `*` [breaking] — Version');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/must not carry the \[breaking\] marker/);
  });

  it('requires served versions to have a section', () => {
    const result = happyChecks({ apiVersionText: apiVersionFixture(['v1', 'v2']) });
    expect(result.errors.join('\n')).toMatch(/v2 is served.*no changelog section/);
  });

  it('requires the head section to be a served version', () => {
    const changelogText = happyChangelog.replace('## v1', '## v2');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/first changelog section is v2/);
  });

  it('requires registered deprecations to be announced with their sunset date', () => {
    const changelogText = happyChangelog.replace('— Planned removal on 2026-09-30.', '— Planned removal soon.');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/2026-09-30/);
  });

  it('requires announced deprecations to be registered', () => {
    const dp = happyDeprecations.slice(0, 0);
    const result = happyChecks({ deprecationsText: deprecationsFixture(dp) });
    expect(result.errors.join('\n')).toMatch(/is not registered in src\/config\/deprecations.ts/);
  });
});

describe('release drift checks', () => {
  it('requires a snapshot for the head API version', () => {
    const result = happyChecks({
      releaseText: createReleaseSnapshot(defaultSpecText, ['v2'], happyDeprecationsText),
    });
    expect(result.errors.join('\n')).toMatch(/missing API version v1/);
  });

  it('requires breaking operation changes to be marked', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ operationId: 'renamedHello' });
    const changelogText = versionedChangelog('### Changed\n\n- `GET /api/hello` — Renamed the generated operation.');
    const unmarked = versionedChecks({ baseline, current, changelogText });
    expect(unmarked.errors.join('\n')).toMatch(/breaking operation change.*must be marked \[breaking\]/);

    const markedText = versionedChangelog(
      '### Changed\n\n- `GET /api/hello` [breaking] — Renamed the generated operation.',
    );
    expect(versionedChecks({ baseline, current, changelogText: markedText }).errors).toEqual([]);
  });

  it('rejects a breaking marker on documentation-only operation changes', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ operationSummary: 'Updated summary' });
    const unmarked = versionedChangelog('### Changed\n\n- `GET /api/hello` — Clarified the summary.');
    expect(versionedChecks({ baseline, current, changelogText: unmarked }).errors).toEqual([]);

    const marked = versionedChangelog('### Changed\n\n- `GET /api/hello` [breaking] — Clarified the summary.');
    expect(versionedChecks({ baseline, current, changelogText: marked }).errors.join('\n')).toMatch(
      /non-breaking operation change.*must not be marked/,
    );
  });

  it('requires breaking shared schema changes to be marked', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ valueType: 'number' });
    const unmarked = versionedChangelog('### Changed\n\n- `*` — Changed the shared response value type.');
    expect(versionedChecks({ baseline, current, changelogText: unmarked }).errors.join('\n')).toMatch(
      /breaking shared API contract change.*must be marked/,
    );

    const marked = versionedChangelog('### Changed\n\n- `*` [breaking] — Changed the shared response value type.');
    expect(versionedChecks({ baseline, current, changelogText: marked }).errors).toEqual([]);
  });

  it('does not classify global documentation changes as breaking', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ infoVersion: '2.0.0' });
    const unmarked = versionedChangelog('### Changed\n\n- `*` — Updated the API metadata version.');
    expect(versionedChecks({ baseline, current, changelogText: unmarked }).errors).toEqual([]);

    const marked = versionedChangelog('### Changed\n\n- `*` [breaking] — Updated the API metadata version.');
    expect(versionedChecks({ baseline, current, changelogText: marked }).errors.join('\n')).toMatch(
      /non-breaking shared API contract change.*must not be marked/,
    );
  });

  it('accepts a documented addition and refreshes the stale snapshot', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ includeNew: true });
    const changelogText = versionedChangelog('### Added\n\n- `GET /api/new` — Added a new endpoint.');
    const releaseText = createReleaseSnapshot(baseline, ['v2'], happyDeprecationsText);
    const checked = versionedChecks({ baseline, current, changelogText, releaseText, allowReleaseDrift: false });
    expect(checked.errors.join('\n')).toMatch(/release snapshot for v2 is stale/);

    const updated = versionedChecks({
      current,
      changelogText,
      releaseText: createReleaseSnapshot(current, ['v2'], happyDeprecationsText),
      allowReleaseDrift: false,
    });
    expect(updated.errors).toEqual([]);
  });

  it('accepts a documented removal and refreshes the stale snapshot', () => {
    const baseline = contractSpecFixture({ includeGone: true });
    const current = contractSpecFixture();
    const changelogText = versionedChangelog(
      '### Removed\n\n- `GET /api/gone` [breaking] — Retired the historical endpoint.',
      historicalChangelog(),
    );
    const checked = versionedChecks({ baseline, current, changelogText, allowReleaseDrift: false });
    expect(checked.errors.join('\n')).toMatch(/release snapshot for v2 is stale/);

    const updated = versionedChecks({
      current,
      changelogText,
      releaseText: createReleaseSnapshot(current, ['v2'], happyDeprecationsText),
      allowReleaseDrift: false,
    });
    expect(updated.errors).toEqual([]);
  });

  it('requires newly registered deprecations in the new head release', () => {
    const baseline = contractSpecFixture();
    const currentDeprecations = [
      ...happyDeprecations,
      { route: '/api/new', sunsetDate: '2027-01-01T00:00:00.000Z' },
    ];
    const currentDeprecationsText = deprecationsFixture(currentDeprecations);
    const releaseText = createReleaseSnapshot(baseline, ['v1'], happyDeprecationsText);
    const inherited = versionedChangelog('### Changed\n\n- `GET /api/hello` — Clarified the endpoint.');
    const result = versionedChecks({
      baseline,
      changelogText: inherited,
      deprecationsText: currentDeprecationsText,
      releaseText,
    });
    expect(result.errors.join('\n')).toMatch(/deprecation for \/api\/new was added or changed/);

    const announced = versionedChangelog(
      '### Deprecated\n\n- `ALL /api/new` — Planned removal on 2027-01-01.',
    );
    expect(
      versionedChecks({
        baseline,
        changelogText: announced,
        deprecationsText: currentDeprecationsText,
        releaseText,
      }).errors,
    ).toEqual([]);
  });

  it('requires deprecation sunset changes and removals in the new head release', () => {
    const baseline = contractSpecFixture();
    const movedDeprecation = [{ route: '/api/rate-limits/config', sunsetDate: '2026-10-31T00:00:00.000Z' }];
    const releaseText = createReleaseSnapshot(baseline, ['v1'], happyDeprecationsText);
    const unchangedChangelog = versionedChangelog('### Changed\n\n- `GET /api/hello` — Clarified the endpoint.');
    const moved = versionedChecks({
      baseline,
      changelogText: unchangedChangelog,
      deprecationsText: deprecationsFixture(movedDeprecation),
      releaseText,
    });
    expect(moved.errors.join('\n')).toMatch(/deprecation for \/api\/rate-limits\/config was added or changed/);

    const removed = versionedChecks({
      baseline,
      changelogText: unchangedChangelog,
      deprecationsText: deprecationsFixture([]),
      releaseText,
    });
    expect(removed.errors.join('\n')).toMatch(/deprecation for \/api\/rate-limits\/config was removed/);

    const documented = versionedChangelog(
      '### Changed\n\n- `ALL /api/rate-limits/config` — Ended the deprecation after the endpoint was restored.',
    );
    expect(
      versionedChecks({
        baseline,
        changelogText: documented,
        deprecationsText: deprecationsFixture([]),
        releaseText,
      }).errors,
    ).toEqual([]);
  });

  it('compares a new head version with the nearest prior snapshot', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ includeNew: true, operationId: 'renamedHello' });
    const changelogText = versionedChangelog('### Added\n\n- `GET /api/new` — Added a new endpoint.');
    const result = versionedChecks({
      baseline,
      current,
      changelogText,
      releaseText: createReleaseSnapshot(baseline, ['v1'], happyDeprecationsText),
      allowReleaseDrift: true,
    });
    expect(result.errors.join('\n')).toMatch(/operation GET \/api\/hello changed.*no Changed or Fixed entry/);
  });

  it('allows a new head version to bootstrap its snapshot', () => {
    const baseline = contractSpecFixture();
    const current = contractSpecFixture({ includeNew: true });
    const changelogText = versionedChangelog('### Added\n\n- `GET /api/new` — Added a new endpoint.');
    const result = versionedChecks({
      baseline,
      current,
      changelogText,
      releaseText: createReleaseSnapshot(baseline, ['v1'], happyDeprecationsText),
      allowReleaseDrift: true,
    });
    expect(result.errors).toEqual([]);
  });
});

describe('checkProject and CLI', () => {
  it('passes for the committed repository', () => {
    const root = process.cwd();
    const result = checkProject({
      changelogPath: path.resolve(root, DEFAULT_PATHS.changelog),
      specPath: path.resolve(root, DEFAULT_PATHS.spec),
      apiVersionPath: path.resolve(root, DEFAULT_PATHS.apiVersion),
      deprecationsPath: path.resolve(root, DEFAULT_PATHS.deprecations),
      releasePath: path.resolve(root, DEFAULT_PATHS.release),
    });
    expect(result.errors).toEqual([]);
  });

  it('reports missing files', () => {
    const result = checkProject({
      changelogPath: path.join(os.tmpdir(), 'does-not-exist.md'),
      specPath: path.join(os.tmpdir(), 'does-not-exist.yaml'),
      apiVersionPath: path.join(os.tmpdir(), 'does-not-exist.ts'),
      deprecationsPath: path.join(os.tmpdir(), 'does-not-exist.ts'),
    });
    expect(result.errors.length).toBe(4);
    expect(result.errors[0]).toMatch(/missing/);
  });

  it('returns exit code 0 for a consistent project and 1 otherwise', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-changelog-cli-'));
    temporary.push(directory);
    fs.writeFileSync(path.join(directory, 'changelog.md'), happyChangelog);
    fs.writeFileSync(path.join(directory, 'openapi.yaml'), defaultSpecText);
    fs.writeFileSync(path.join(directory, 'api-version.ts'), apiVersionFixture());
    fs.writeFileSync(path.join(directory, 'deprecations.ts'), deprecationsFixture(happyDeprecations));
    fs.writeFileSync(path.join(directory, 'releases.json'), defaultReleaseText);

    const args = [
      '--changelog',
      'changelog.md',
      '--spec',
      'openapi.yaml',
      '--api-version',
      'api-version.ts',
      '--deprecations',
      'deprecations.ts',
      '--release',
      'releases.json',
    ];
    expect(main(args, directory)).toBe(0);

    fs.writeFileSync(path.join(directory, 'openapi.yaml'), specFixture({ ...defaultSpec, '/api/new': ['GET'] }));
    expect(main(args, directory)).toBe(1);
  });

  it('creates and refreshes the release snapshot in update mode', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-changelog-update-'));
    temporary.push(directory);
    fs.writeFileSync(path.join(directory, 'changelog.md'), happyChangelog);
    fs.writeFileSync(path.join(directory, 'openapi.yaml'), defaultSpecText);
    fs.writeFileSync(path.join(directory, 'api-version.ts'), apiVersionFixture());
    fs.writeFileSync(path.join(directory, 'deprecations.ts'), deprecationsFixture(happyDeprecations));

    const args = [
      '--changelog',
      'changelog.md',
      '--spec',
      'openapi.yaml',
      '--api-version',
      'api-version.ts',
      '--deprecations',
      'deprecations.ts',
      '--release',
      'releases.json',
    ];
    expect(main([...args, '--update-release'], directory)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'releases.json'), 'utf8'))).toHaveProperty('v1');

    const changedChangelog = happyChangelog.replace(
      '### Deprecated',
      '- `GET /api/new` — Added a new endpoint.\n\n### Deprecated',
    );
    fs.writeFileSync(path.join(directory, 'changelog.md'), changedChangelog);
    fs.writeFileSync(path.join(directory, 'openapi.yaml'), specFixture({ ...defaultSpec, '/api/new': ['GET'] }));
    expect(main([...args, '--update-release'], directory)).toBe(0);
    expect(main(args, directory)).toBe(0);
  });
});

describe('formatResult', () => {
  it('summarizes failures', () => {
    const { errors, summary } = happyChecks({ spec: { ...defaultSpec, '/api/hello': ['GET'], '/api/other': ['GET'] } });
    const lines = formatResult({ errors, summary }).split('\n');
    expect(lines[0]).toMatch(/failed/);
    expect(lines.slice(1)).toEqual(errors.map((error) => `  - ${error}`));
  });
});

describe('ChangelogError', () => {
  it('carries a machine-readable code', () => {
    const error = new ChangelogError('oops', 'SOME_CODE');
    expect(error.name).toBe('ChangelogError');
    expect(error.code).toBe('SOME_CODE');
    expect(error.message).toBe('oops');
  });
});