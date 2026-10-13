// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderOnboardingMarkdown } from '@maktab/shared/guide-markdown';
import { describe, expect, it } from 'vitest';

/* `npm run docs:guide`: docs/onboarding.md is generated from the guide content (CI: --check). */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('docs:guide', () => {
  it('matches the committed docs/onboarding.md (run `npm run docs:guide` after editing)', () => {
    expect(readFileSync(join(root, 'docs', 'onboarding.md'), 'utf8')).toBe(
      renderOnboardingMarkdown(),
    );
  });

  it('is idempotent, and --check passes on the committed file', () => {
    const run = (...args: string[]) =>
      execFileSync('npx', ['tsx', 'scripts/docs-guide.ts', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
    expect(run()).toContain('unchanged');
    expect(run('--check')).toContain('up to date');
  });
});
