#!/usr/bin/env node
// First-load budget for the built web app (M7). Run after `npm run build`:
//   node apps/web/scripts/bundle-budget.mjs [distDir]
// Counts what index.html makes the browser fetch before anything renders (the entry script and
// every modulepreload), gzip-compressed, and fails CI when it grows past the budget or when a
// dependency that belongs to lazy routes (zod, the Urdu dictionary) leaks into it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ENTRY_BUDGET_KB = 150;
const INITIAL_BUDGET_KB = 200;

const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = /<script type="module"[^>]*src="\/([^"]+\.js)"/.exec(html)?.[1];
const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*href="\/([^"]+\.js)"/g)].map(
  (m) => m[1],
);
if (!entry) {
  console.error('bundle-budget: no entry script in index.html');
  process.exit(1);
}
const kb = (file) => gzipSync(readFileSync(join(dist, file))).length / 1024;
const entryKb = kb(entry);
let initialKb = 0;
const problems = [];
for (const file of [entry, ...preloads]) {
  initialKb += kb(file);
  const code = readFileSync(join(dist, file), 'utf8');
  if (/ZodError|invalid_type/.test(code)) problems.push(`${file} contains zod`);
  if (file.includes('i18n-ur') || code.includes('اسکول کا نام')) problems.push(`${file} is Urdu`);
}
console.log(
  `first load: entry ${entryKb.toFixed(1)} KB gzip (budget ${ENTRY_BUDGET_KB}), ` +
    `${1 + preloads.length} files ${initialKb.toFixed(1)} KB gzip (budget ${INITIAL_BUDGET_KB})`,
);
if (entryKb > ENTRY_BUDGET_KB) problems.push(`entry chunk over ${ENTRY_BUDGET_KB} KB`);
if (initialKb > INITIAL_BUDGET_KB) problems.push(`first load over ${INITIAL_BUDGET_KB} KB`);
for (const p of problems) console.error(`bundle-budget: ${p}`);
process.exit(problems.length ? 1 : 0);
