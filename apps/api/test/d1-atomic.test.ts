import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic, family, getDb, rawStatement } from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

/**
 * The D1 path of atomic() (packages/db/src/client.ts) against workerd's real D1 implementation via
 * wrangler's getPlatformProxy (in-memory, nothing persisted). better-sqlite3 tests never reach this
 * branch, and it is the one that broke on real D1 before (raw statements had no `.bind`).
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;

const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(import.meta.dirname, '../wrangler.toml'),
    persist: false,
  });
  // Every migration, one batch each (as `wrangler d1 migrations apply` does): this also proves the
  // migrations themselves run on D1.
  for (const f of migrationFiles()) {
    const stmts = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '');
    await proxy.env.DB.batch(stmts.map((s) => proxy.env.DB.prepare(s)));
  }
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe('atomic() on D1', () => {
  it('runs raw SQL with params, a drizzle builder and a json_each insert in one batch', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const progs = JSON.stringify([
      { id: 'P1', name: 'Class 1' },
      { id: 'P2', name: 'Class 2' },
    ]);
    await atomic(db, () => [
      rawStatement(
        db,
        sql`INSERT INTO family (id, name, area) VALUES (${'F1'}, ${'Khan'}, ${'Gulberg'})`,
      ),
      db.insert(family).values({ id: 'F2', name: 'Ahmed' }),
      rawStatement(
        db,
        sql`INSERT INTO programme (id, name, kind)
            SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), 'grade'
            FROM json_each(${progs})`,
      ),
    ]);
    const fams = await proxy.env.DB.prepare('SELECT id, area FROM family ORDER BY id').all();
    expect(fams.results).toEqual([
      { id: 'F1', area: 'Gulberg' },
      { id: 'F2', area: null },
    ]);
    const n = await proxy.env.DB.prepare('SELECT count(*) AS n FROM programme').first<{
      n: number;
    }>();
    expect(n?.n).toBe(2);
  });

  it('a failing last statement rolls back everything before it', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const err = await atomic(db, () => [
      rawStatement(db, sql`INSERT INTO family (id, name) VALUES (${'F3'}, ${'Rolled back'})`),
      db.insert(family).values({ id: 'F4', name: 'Also rolled back' }),
      rawStatement(
        db,
        sql`INSERT INTO programme (id, name, kind)
            SELECT 'P3', 'X', 'grade' FROM json_each(${'[1]'})`,
      ),
      // Duplicate primary key: the batch must fail as a whole.
      rawStatement(db, sql`INSERT INTO family (id, name) VALUES (${'F1'}, ${'dup'})`),
    ]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    const left = await proxy.env.DB.prepare(
      `SELECT (SELECT count(*) FROM family WHERE id IN ('F3', 'F4')) AS f,
              (SELECT count(*) FROM programme WHERE id = 'P3') AS p`,
    ).first<{ f: number; p: number }>();
    expect(left).toEqual({ f: 0, p: 0 });
  });
});
