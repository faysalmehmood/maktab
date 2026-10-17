import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  applyD1Migrations,
  D1_MIGRATIONS_TABLE,
  MIGRATIONS_DIR,
  migrationNames,
  verifySchema,
} from '../src/node';

/** The schema as SQL text, internals excluded (both migrators' own tables, sqlite_*). */
const schemaOf = (db: Database.Database) =>
  db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
       AND name NOT IN ('${D1_MIGRATIONS_TABLE}', '__drizzle_migrations') ORDER BY type, name`,
    )
    .all();

describe('wrangler-compatible migrations on a local SQLite file (self-hosted)', () => {
  it('orders files the way wrangler does', () => {
    const names = migrationNames(MIGRATIONS_DIR);
    expect(names[0]).toBe('0000_init.sql');
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => n.endsWith('.sql'))).toBe(true);
    expect(names).not.toContain('custom_sql.json');
    expect(names.length).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length);
    const dir = mkdtempSync(join(tmpdir(), 'maktab-order-'));
    try {
      for (const n of ['10_b.sql', '2_a.sql', 'zz.sql', '0001_x.sql'])
        writeFileSync(join(dir, n), '');
      expect(migrationNames(dir)).toEqual(['0001_x.sql', '2_a.sql', '10_b.sql', 'zz.sql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the same schema as the drizzle migrator the tests use, and passes db:verify', async () => {
    const viaD1 = new Database(':memory:');
    viaD1.pragma('foreign_keys = ON');
    const applied = applyD1Migrations(viaD1);
    expect(applied).toEqual(migrationNames(MIGRATIONS_DIR));
    const { getDb, migrateLocal } = await import('../src/node');
    const viaDrizzle = getDb({ SQLITE_PATH: ':memory:' });
    migrateLocal(viaDrizzle);
    const client = (viaDrizzle as unknown as { $client: Database.Database }).$client;
    expect(schemaOf(viaD1)).toEqual(schemaOf(client));
    const v = verifySchema(viaD1);
    expect(v.missing).toEqual([]);
    expect(v.extra).toEqual([]);
    expect(v.triggers).toBe(v.expectedTriggers);
    // wrangler's columns and the file name with `.sql`.
    const cols = viaD1
      .prepare(`SELECT name FROM pragma_table_info('${D1_MIGRATIONS_TABLE}')`)
      .all();
    expect(cols).toEqual([{ name: 'id' }, { name: 'name' }, { name: 'applied_at' }]);
    // Idempotent.
    expect(applyD1Migrations(viaD1)).toEqual([]);
  });

  it('a failing migration rolls back whole and is not recorded; fixing it lets the next start apply it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maktab-mig-'));
    try {
      const first = migrationNames(MIGRATIONS_DIR).slice(0, 2);
      for (const n of first) copyFileSync(join(MIGRATIONS_DIR, n), join(dir, n));
      writeFileSync(
        join(dir, '9000_bad.sql'),
        'CREATE TABLE half_done (id INTEGER);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);',
      );
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      expect(() => applyD1Migrations(db, dir)).toThrow(/9000_bad\.sql/);
      const names = (
        db.prepare(`SELECT name FROM ${D1_MIGRATIONS_TABLE}`).all() as { name: string }[]
      ).map((r) => r.name);
      expect(names).toEqual(first);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").all()).toEqual(
        [],
      );
      expect(db.inTransaction).toBe(false);
      writeFileSync(join(dir, '9000_bad.sql'), 'CREATE TABLE half_done (id INTEGER);');
      expect(applyD1Migrations(db, dir)).toEqual(['9000_bad.sql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
