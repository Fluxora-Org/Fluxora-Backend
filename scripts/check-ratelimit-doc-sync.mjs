#!/usr/bin/env node
/**
 * Issue #1474 — assert openapi.yaml rate-limit docs match the code.
 * Runs with `node scripts/check-ratelimit-doc-sync.mjs` — no installs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
function readFile(p) {
  try { return readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); }
  catch (e) { console.error('Cannot read ' + p + ': ' + e.message); process.exit(2); }
}

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

// ---- Parse openapi.yaml ----------------------------------------------------
const spec = readFile('openapi.yaml');

// Locate the x-rate-limits block and slice it out by line number.
function sliceBlock(src, header) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.match(new RegExp('^' + header + ':')));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].match(/^\S/)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

const rl = sliceBlock(spec, 'x-rate-limits');
if (!rl) { console.error('openapi.yaml: missing x-rate-limits block'); process.exit(1); }

// Extract a tier's windowSeconds and max.
function tier(name) {
  const lines = rl.split('\n');
  const start = lines.findIndex((l) => l.match(new RegExp('^    ' + name + ':$')));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].match(/^    \S/)) { end = i; break; }
  }
  const block = lines.slice(start, end).join('\n');
  const win = block.match(/windowSeconds:[ \t]*(\d+)/);
  const max = block.match(/max:[ \t]*(\d+)/);
  return { windowSeconds: win ? Number(win[1]) : null, max: max ? Number(max[1]) : null };
}
const specTiers = { ip: tier('ip'), apiKey: tier('apiKey'), admin: tier('admin') };

// Extract route budgets.
const specBudgets = [];
const budgetRe = /- path:[ \t]*(\S+)\n[\s\S]*?baseLimit:[ \t]*(\d+)\n[\s\S]*?writeLimit:[ \t]*(\d+)\n[\s\S]*?exempt:[ \t]*(true|false)/g;
let bm;
while ((bm = budgetRe.exec(rl)) !== null) {
  specBudgets.push({
    path: bm[1],
    baseLimit: Number(bm[2]),
    writeLimit: Number(bm[3]),
    exempt: bm[4] === 'true',
  });
}

// Extract documented header names — look under components.headers, not x-rate-limits.
const componentsHeaders = sliceBlock(spec, 'components');
const specHeaders = {};
for (const h of ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After']) {
  specHeaders[h] = new RegExp('^    ' + h + ':', 'm').test(componentsHeaders || '');
}

// ---- Parse src/config/rateLimits.ts ---------------------------------------
const configTs = readFile('src/config/rateLimits.ts');

function extractConst(name) {
  const m = configTs.match(new RegExp('export const ' + name + '[^=]*=[ \t]*\\{([\\s\\S]*?)\\}', 'm'));
  if (!m) return null;
  const win = m[1].match(/windowMs:[ \t]*([\d_]+)/);
  const max = m[1].match(/max:[ \t]*([\d_]+)/);
  return {
    windowMs: win ? Number(win[1].replace(/_/g, '')) : null,
    max: max ? Number(max[1].replace(/_/g, '')) : null,
  };
}
const codeTiers = {
  ip: extractConst('DEFAULT_IP_CONFIG'),
  apiKey: extractConst('DEFAULT_APIKEY_CONFIG'),
  admin: extractConst('DEFAULT_ADMIN_CONFIG'),
};

const budgetBlock = (configTs.match(/export const ROUTE_BUDGETS[\s\S]*?=[ \t]*\[([\s\S]*?)\];/) || [])[1] || '';
const codeBudgets = [];
const codeBudgetRe = /path:[ \t]*['"`]([^'"`]+)['"`][\s\S]*?baseLimit:[ \t]*(\d+)[\s\S]*?writeLimit:[ \t]*(\d+)[\s\S]*?exempt:[ \t]*(true|false)/g;
let cm;
while ((cm = codeBudgetRe.exec(budgetBlock)) !== null) {
  codeBudgets.push({
    path: cm[1],
    baseLimit: Number(cm[2]),
    writeLimit: Number(cm[3]),
    exempt: cm[4] === 'true',
  });
}

// ---- Parse src/types/rateLimit.ts for header names -------------------------
const typesTs = readFile('src/types/rateLimit.ts');
const codeHeaders = {};
for (const key of ['limit', 'remaining', 'reset', 'retryAfter']) {
  const m = typesTs.match(new RegExp(key + ":[ \t]*['\"]([^'\"]+)['\"]"));
  codeHeaders[key] = m ? m[1] : null;
}

// ---- Compare ---------------------------------------------------------------
for (const t of ['ip', 'apiKey', 'admin']) {
  check(specTiers[t] && codeTiers[t], 'tier ' + t + ' present in both: spec=' + JSON.stringify(specTiers[t]) + ' code=' + JSON.stringify(codeTiers[t]));
  if (specTiers[t] && codeTiers[t]) {
    check(specTiers[t].windowSeconds === codeTiers[t].windowMs / 1000,
      'tier ' + t + ' windowSeconds: spec=' + specTiers[t].windowSeconds + ' code=' + codeTiers[t].windowMs / 1000);
    check(specTiers[t].max === codeTiers[t].max,
      'tier ' + t + ' max: spec=' + specTiers[t].max + ' code=' + codeTiers[t].max);
  }
}

check(specBudgets.length === codeBudgets.length,
  'budget count: spec=' + specBudgets.length + ' code=' + codeBudgets.length);
for (const cb of codeBudgets) {
  const sb = specBudgets.find((b) => b.path === cb.path);
  check(!!sb, 'route ' + cb.path + ' documented');
  if (!sb) continue;
  check(sb.baseLimit === cb.baseLimit, 'route ' + cb.path + ' baseLimit spec=' + sb.baseLimit + ' code=' + cb.baseLimit);
  check(sb.writeLimit === cb.writeLimit, 'route ' + cb.path + ' writeLimit spec=' + sb.writeLimit + ' code=' + cb.writeLimit);
  check(sb.exempt === cb.exempt, 'route ' + cb.path + ' exempt spec=' + sb.exempt + ' code=' + cb.exempt);
}

for (const h of ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After']) {
  check(specHeaders[h], 'header ' + h + ' documented in components.headers');
}

check(codeHeaders.limit === 'X-RateLimit-Limit', 'code header limit=' + codeHeaders.limit);
check(codeHeaders.remaining === 'X-RateLimit-Remaining', 'code header remaining=' + codeHeaders.remaining);
check(codeHeaders.reset === 'X-RateLimit-Reset', 'code header reset=' + codeHeaders.reset);
check(codeHeaders.retryAfter === 'Retry-After', 'code header retryAfter=' + codeHeaders.retryAfter);

// ---- Report ----------------------------------------------------------------
if (failures.length === 0) {
  console.log('OK - openapi.yaml rate-limit docs match the code');
  process.exit(0);
}
console.error('DRIFT DETECTED (' + failures.length + '):');
for (const f of failures) console.error('  - ' + f);
process.exit(1);