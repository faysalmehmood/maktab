// `npm run build:node -w @maktab/api`: bundles src/node.ts (the self-hosted server) into
// dist-node/node.mjs for Node 22+. better-sqlite3 stays external (a native module, loaded from
// node_modules at run time); everything else, workspace packages included, is bundled. The Worker
// build (`wrangler deploy --dry-run`) never sees this file.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: [fileURLToPath(new URL('../src/node.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist-node/node.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  sourcemap: true,
  // CommonJS dependencies bundled into ESM still call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __maktabRequire } from 'node:module'; const require = __maktabRequire(import.meta.url);",
  },
  logLevel: 'info',
});
