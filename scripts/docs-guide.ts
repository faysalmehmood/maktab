// `npm run docs:guide`: regenerate docs/onboarding.md from the guide content
// (packages/shared/src/guide), so the in-app guide and the repo doc never drift.
// `npm run docs:guide -- --check` exits 1 when the committed file is out of date (CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderOnboardingMarkdown } from '../packages/shared/src/guide/markdown';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'onboarding.md');
const want = renderOnboardingMarkdown();
let have = '';
try {
  have = readFileSync(file, 'utf8');
} catch {
  // missing: written below, or reported by --check
}
if (process.argv.includes('--check')) {
  if (have !== want) {
    console.error('docs/onboarding.md is out of date: run `npm run docs:guide` and commit it.');
    process.exit(1);
  }
  console.log('docs/onboarding.md is up to date.');
} else if (have === want) {
  console.log('docs/onboarding.md unchanged.');
} else {
  writeFileSync(file, want);
  console.log('docs/onboarding.md written.');
}
