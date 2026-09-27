/**
 * Generates `docs/env-reference.md` from the composed environment schema.
 *
 * Usage: pnpm tsx scripts/generate-env-reference.ts [--check]
 *
 * Every variable in the composed schema is listed with its subsystem, its
 * JSDoc description (purpose), and its declared default (or "—").
 * With `--check`, exits 1 if the generated file is stale (CI-friendly).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EnvSchemaShape } from '../src/config/env-schema/schema.js';
import {
  coreEnvSchema,
  databaseEnvSchema,
  redisEnvSchema,
  stellarEnvSchema,
  authEnvSchema,
  httpEnvSchema,
  webhooksEnvSchema,
  serverEnvSchema,
  indexerEnvSchema,
  rateLimitEnvSchema,
  infrastructureEnvSchema,
} from '../src/config/env-schema/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, '..', 'docs', 'env-reference.md');
const SCHEMA_DIR = resolve(here, '..', 'src', 'config', 'env-schema');

type Fragment = Record<string, z.ZodTypeAny>;

const FRAGMENTS: Array<{ subsystem: string; file: string; schema: Fragment }> = [
  { subsystem: 'Core', file: 'core.ts', schema: coreEnvSchema },
  { subsystem: 'Database', file: 'database.ts', schema: databaseEnvSchema },
  { subsystem: 'Redis', file: 'redis.ts', schema: redisEnvSchema },
  { subsystem: 'Stellar', file: 'stellar.ts', schema: stellarEnvSchema },
  { subsystem: 'Auth & Secrets', file: 'auth.ts', schema: authEnvSchema },
  { subsystem: 'HTTP', file: 'http.ts', schema: httpEnvSchema },
  { subsystem: 'Webhooks', file: 'webhooks.ts', schema: webhooksEnvSchema },
  { subsystem: 'Server', file: 'server.ts', schema: serverEnvSchema },
  { subsystem: 'Indexer', file: 'indexer.ts', schema: indexerEnvSchema },
  { subsystem: 'Rate limiting', file: 'rateLimit.ts', schema: rateLimitEnvSchema },
  { subsystem: 'Infrastructure & Ops', file: 'infrastructure.ts', schema: infrastructureEnvSchema },
];

interface VarDoc {
  name: string;
  subsystem: string;
  purpose: string;
  defaultText: string;
}

/**
 * Extract a JSDoc purpose string per env-var name from a fragment's source.
 * A field is recognized by `NAME:` at the start of a trimmed line; the
 * preceding `/** ... *\/` block provides its description. Handles both
 * single-line (`/** doc *\/`) and multi-line blocks.
 */
function extractJsdocMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = source.split('\n');
  let comment: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('/**')) {
      comment = [];
      const inline = line.replace(/^\/\*\*/, '').replace(/\*\/$/, '').trim();
      if (inline.length > 0) comment.push(inline);
      // A single-line doc may sit above the field on the SAME line only when
      // the field follows on the next line, so nothing more to do here.
      continue;
    }
    if (line.startsWith('*') && !line.startsWith('*/')) {
      comment.push(line.replace(/^\*\s?/, ''));
      continue;
    }

    const field = line.match(/^([A-Z][A-Z0-9_]+):/);
    if (field) {
      const name = field[1];
      if (name && !map.has(name) && comment.length > 0) {
        map.set(name, comment.join(' ').replace(/\s+/g, ' ').trim());
      }
      comment = [];
      continue;
    }

    if (line.startsWith('*/')) {
      continue; // keep the accumulated comment for the upcoming field line
    }
    if (line.startsWith('//') || line.startsWith('import') || line.startsWith('export')) {
      if (comment.length === 0) continue;
      comment = [];
      continue;
    }
    if (line.length > 0) {
      comment = []; // non-comment code: reset
    }
  }
  return map;
}

/** Read the declared default of a (possibly preprocessed) zod schema. */
function extractDefault(schema: z.ZodTypeAny): string {
  const candidates: unknown[] = [schema];
  const inner = (schema as { schema?: unknown }).schema;
  if (inner) candidates.unshift(inner); // unwrap z.preprocess

  for (const candidate of candidates) {
    const def = (candidate as { _zod?: { def?: { defaultValue?: unknown } } })._zod?.def;
    if (def && 'defaultValue' in def) {
      const value = def.defaultValue;
      if (typeof value === 'function') {
        const resolved = (value as () => unknown)();
        return formatValue(resolved);
      }
      return formatValue(value);
    }
  }
  return '—';
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'unset (optional)';
  return `\`${String(value)}\``;
}

function loadPurposeMap(): Map<string, string> {
  const merged = new Map<string, string>();
  for (const fragment of FRAGMENTS) {
    const source = readFileSync(resolve(SCHEMA_DIR, fragment.file), 'utf8');
    for (const [name, doc] of extractJsdocMap(source)) {
      if (!merged.has(name)) merged.set(name, doc);
    }
  }
  return merged;
}

function buildRows(purposes: Map<string, string>): VarDoc[] {
  const docs: VarDoc[] = [];
  const claimed = new Set<string>();

  for (const { subsystem, schema } of FRAGMENTS) {
    for (const name of Object.keys(schema)) {
      claimed.add(name);
      docs.push({
        name,
        subsystem,
        purpose: purposes.get(name) ?? '—',
        defaultText: extractDefault(schema[name]),
      });
    }
  }

  for (const [name, schema] of Object.entries(EnvSchemaShape)) {
    if (!claimed.has(name)) {
      docs.push({
        name,
        subsystem: 'Uncategorized',
        purpose: purposes.get(name) ?? '—',
        defaultText: extractDefault(schema),
      });
    }
  }

  return docs.sort((a, b) => a.name.localeCompare(b.name));
}

function renderTable(vars: VarDoc[]): string {
  let out = '| Variable | Purpose | Default |\n|---|---|---|\n';
  for (const v of vars) {
    const purpose = v.purpose.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') || '—';
    out += `| \`${v.name}\` | ${purpose} | ${v.defaultText} |\n`;
  }
  return out + '\n';
}

function renderMarkdown(docs: VarDoc[]): string {
  let out = `<!-- GENERATED FILE — do not edit by hand. Run \`pnpm tsx scripts/generate-env-reference.ts\` to regenerate. -->\n\n`;
  out += `# Environment Variable Reference\n\n`;
  out += `Generated from the composed environment schema (\`src/config/env-schema/schema.ts\`,\n`;
  out += `issue #1519). ${docs.length} variables across ${FRAGMENTS.length} subsystems.\n\n`;
  out += `“—” in the Default column means the variable has no schema-level default\n`;
  out += `(required, or optional with a runtime fallback).\n\n`;

  const bySubsystem = new Map<string, VarDoc[]>();
  for (const doc of docs) {
    const list = bySubsystem.get(doc.subsystem) ?? [];
    list.push(doc);
    bySubsystem.set(doc.subsystem, list);
  }

  for (const { subsystem } of FRAGMENTS) {
    const vars = bySubsystem.get(subsystem);
    if (!vars || vars.length === 0) continue;
    out += `## ${subsystem}\n\n`;
    out += renderTable(vars);
  }

  const leftovers = bySubsystem.get('Uncategorized') ?? [];
  if (leftovers.length > 0) {
    out += `## Uncategorized\n\n`;
    out += `Present in the composed schema but not claimed by a fragment in \`index.ts\`.\n\n`;
    out += renderTable(leftovers);
  }

  return out;
}

function main(): void {
  const purposes = loadPurposeMap();
  const docs = buildRows(purposes);
  const markdown = renderMarkdown(docs);

  if (process.argv.includes('--check')) {
    let current: string | null = null;
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      current = null;
    }
    if (current !== markdown) {
      console.error(
        'docs/env-reference.md is stale. Run `pnpm tsx scripts/generate-env-reference.ts`.'
      );
      process.exit(1);
    }
    console.log(`env-reference.md is up to date (${docs.length} variables).`);
    return;
  }

  writeFileSync(OUTPUT, markdown);
  console.log(`Wrote ${OUTPUT} (${docs.length} variables).`);
}

main();
