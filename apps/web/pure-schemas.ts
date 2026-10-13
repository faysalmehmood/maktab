/**
 * Build-time helper for vite.config.ts (M7 bundle work).
 *
 * @maktab/shared declares its zod schemas as top-level constants for the API. The web never parses
 * with them (src/lib/api.ts uses hand-written guards), but a bundler must keep any top-level call it
 * cannot prove pure — and zod's chained builders (`z.string().trim().max(80)`) defeat a plain
 * `@__PURE__` on the first call. So each top-level `const X = <expression using zod>` becomes
 * `const X = /* @__PURE__ *\/ (() => (<expression>))()`: same value, same evaluation order, but an
 * unused one is dropped whole — and with no schema left, so is zod (~55 KB gzip of the first load).
 *
 * Line-based on purpose: the shared files are Biome-formatted (top-level statements start in
 * column 0 and end with `;`). Functions and arrows are left alone (already free to drop).
 */
const DECL = /^((?:export )?const \w+(?:: [^=]+)? = ?)(.*)$/;

const startsNewStatement = (line: string | undefined) =>
  line === undefined || line === '' || (/^\S/.test(line) && !/^[.)\]}]/.test(line));

export function markSchemasPure(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i] ?? '');
    if (!m) {
      out.push(lines[i] ?? '');
      continue;
    }
    let j = i;
    while (
      j < lines.length &&
      !((lines[j] ?? '').endsWith(';') && startsNewStatement(lines[j + 1]))
    )
      j++;
    if (j >= lines.length) {
      out.push(lines[i] ?? '');
      continue;
    }
    const head = m[1] ?? '';
    const rhs = [m[2] ?? '', ...lines.slice(i + 1, j + 1)].join('\n').replace(/;$/, '');
    const body = rhs.trim();
    const usesZod = /(?<![\w.])z\s*\.|\w+Schema\b/.test(body);
    const isFunction = /^(?:\(|function\b|async\b|<)/.test(body);
    if (!usesZod || isFunction) {
      out.push(...lines.slice(i, j + 1));
    } else {
      out.push(`${head.trimEnd()} /* @__PURE__ */ (() => (${rhs.trimStart()}))();`);
    }
    i = j;
  }
  return out.join('\n');
}
