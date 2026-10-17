/**
 * sql/*.sql is the hand-written source of truth for triggers, partial indexes and views. Applied
 * migrations are immutable, so a change to sql/ never rewrites an old migration: it becomes a NEW
 * numbered custom migration (drizzle-kit `--custom`, so the journal and both migrators see it).
 *
 * migrations/custom_sql.json (outside meta/, which drizzle-kit parses as snapshots) records, per custom migration, the sha256 of the migration file
 * and of each sql/ file it carries. A changed file is re-emitted whole, preceded by DROP … IF EXISTS
 * for every object its previous version (and its new version) creates, so it re-runs cleanly; a
 * deleted file emits only the drops.
 *
 * Usage: tsx scripts/sync-custom-sql.ts [--check] [--name <tag>]
 *   (default) emit a new migration if sql/ differs from the manifest, else do nothing
 *   --check   exit 1 if sql/ has unrecorded changes or a recorded migration was edited (CI)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createdObjects } from '../src/schema-check';

export { createdObjects };

const root = fileURLToPath(new URL('..', import.meta.url));
const SQL_DIR = join(root, 'sql');
const MIGRATIONS = join(root, 'migrations');
export const MANIFEST = 'migrations/custom_sql.json';
const BREAK = '--> statement-breakpoint';

export type ManifestEntry = { migration: string; sha256: string; files: Record<string, string> };
export type Manifest = { entries: ManifestEntry[] };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function readManifest(): Manifest {
  const path = join(root, MANIFEST);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : { entries: [] };
}

export function currentSqlFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    out[f] = readFileSync(join(SQL_DIR, f), 'utf8').trim();
  return out;
}

/** file -> {hash, migration} of the latest migration that emitted it (absent once deleted). */
function latest(manifest: Manifest): Map<string, { hash: string; migration: string }> {
  const m = new Map<string, { hash: string; migration: string }>();
  for (const e of manifest.entries) {
    for (const [f, h] of Object.entries(e.files)) {
      if (h === 'deleted') m.delete(f);
      else m.set(f, { hash: h, migration: e.migration });
    }
  }
  return m;
}

export type Pending = { changed: string[]; deleted: string[] };

export function pendingChanges(manifest = readManifest(), files = currentSqlFiles()): Pending {
  const last = latest(manifest);
  const changed = Object.keys(files).filter((f) => last.get(f)?.hash !== sha(files[f] ?? ''));
  const deleted = [...last.keys()].filter((f) => !(f in files));
  return { changed, deleted };
}

/** drizzle's migrator runs every chunk; a trailing breakpoint would leave an empty one. */
const stripTrailingBreak = (s: string) => s.replace(/\s*--> statement-breakpoint\s*$/, '');

/** The text a migration carried for one source file (between its `-- source:` markers). */
function sectionOf(migration: string, file: string): string {
  const text = readFileSync(join(MIGRATIONS, `${migration}.sql`), 'utf8');
  const start = text.indexOf(`-- source: sql/${file}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n-- source: sql/');
  return next < 0 ? rest : rest.slice(0, next);
}

export function buildMigration(
  pending: Pending,
  manifest = readManifest(),
  files = currentSqlFiles(),
): string {
  const last = latest(manifest);
  const parts: string[] = [];
  for (const f of [...pending.deleted, ...pending.changed].sort()) {
    const prev = last.get(f);
    const old = prev ? createdObjects(sectionOf(prev.migration, f)) : [];
    const now = f in files ? createdObjects(files[f] ?? '') : [];
    const seen = new Set<string>();
    const drops = [...old, ...now]
      .reverse()
      .filter((o) => !seen.has(o.name) && seen.add(o.name))
      .map((o) => `DROP ${o.kind} IF EXISTS ${o.name};\n${BREAK}`);
    const body = f in files ? stripTrailingBreak(files[f] ?? '') : '-- (file deleted)';
    parts.push(
      prev && drops.length
        ? `-- source: sql/${f}\n${drops.join('\n')}\n${body}`
        : `-- source: sql/${f}\n${body}`,
    );
  }
  return `${stripTrailingBreak(parts.join(`\n${BREAK}\n\n`))}\n`;
}

/** Problems CI should fail on; empty means migrations and sql/ agree. */
export function checkCustomSql(): string[] {
  const manifest = readManifest();
  const problems: string[] = [];
  for (const e of manifest.entries) {
    const path = join(MIGRATIONS, `${e.migration}.sql`);
    if (!existsSync(path)) problems.push(`${e.migration}.sql is missing`);
    else if (sha(readFileSync(path, 'utf8')) !== e.sha256)
      problems.push(`${e.migration}.sql was edited after it was generated; add a new migration`);
  }
  const p = pendingChanges(manifest);
  for (const f of p.changed) problems.push(`sql/${f} changed; run npm run db:generate`);
  for (const f of p.deleted) problems.push(`sql/${f} was deleted; run npm run db:generate`);
  return problems;
}

function lastJournalTag(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tag = journal.entries.at(-1)?.tag;
  if (!tag) throw new Error('empty drizzle journal');
  return tag;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = checkCustomSql();
    for (const p of problems) console.error(p);
    process.exit(problems.length ? 1 : 0);
  }
  const manifest = readManifest();
  const files = currentSqlFiles();
  const pending = pendingChanges(manifest, files);
  if (!pending.changed.length && !pending.deleted.length) {
    console.log('custom SQL up to date');
    process.exit(0);
  }
  const nameIdx = process.argv.indexOf('--name');
  const name = nameIdx > 0 ? (process.argv[nameIdx + 1] ?? 'custom_sql') : 'custom_sql';
  const before = lastJournalTag();
  execFileSync('npx', ['drizzle-kit', 'generate', '--custom', '--name', name], {
    cwd: root,
    stdio: 'inherit',
  });
  const tag = lastJournalTag();
  if (tag === before) throw new Error('drizzle-kit did not create a custom migration');
  const body = buildMigration(pending, manifest, files);
  writeFileSync(join(MIGRATIONS, `${tag}.sql`), body);
  const recorded: Record<string, string> = {};
  for (const f of pending.changed) recorded[f] = sha(files[f] ?? '');
  for (const f of pending.deleted) recorded[f] = 'deleted';
  manifest.entries.push({ migration: tag, sha256: sha(body), files: recorded });
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote migrations/${tag}.sql (${Object.keys(recorded).join(', ')})`);
}
