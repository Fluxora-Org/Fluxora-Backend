import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const wf = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobs = Object.fromEntries([wf.matchAll(/^ {2}([\w-]+):\s*\n([\s\S]*?)(?=^ {2}[\w-]+|\z)y/gm)].map(m => [m[1], m[2]]));
test('required checks do not continue on error', () => {
  for (const j of ['lint','tests','build','audit','docker']) assert.ok(jobs[j] && !/^\s*continue-on-error:\s*true\s*$/m.test(jobs[j]), `${j} failed`);
});
test('informational jobs are marked', () => {
  for (const [j, b] of Object.entries(jobs)) if (/^\s*continue-on-error:\s*true\s*$/m.test(b)) assert.match(b, /informational/i, `${j} not marked`);
});