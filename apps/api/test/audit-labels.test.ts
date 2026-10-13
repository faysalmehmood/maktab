import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { en, ur } from '@maktab/shared';
import { describe, expect, it } from 'vitest';

// Every (entity, action) the code writes to `audit` must have an en and ur label on the audit
// screen (money.audit.entities / actions), or the owner reads a raw key like `share_parent_link`.
// Scans the source: audit rows come from auditSql({...}), the ledger's audit helper, and raw
// `INSERT INTO audit` statements. Dynamic values (entity: tbl) are listed in DYNAMIC_ENTITIES.

const root = join(__dirname, '..', '..', '..');
const DYNAMIC_ENTITIES = ['programme', 'subject', 'fee_head', 'grp', 'custom_field']; // restore + custom fields

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const words = (expr: string) => [...expr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

function collect() {
  const entities = new Set<string>(DYNAMIC_ENTITIES);
  const actions = new Set<string>();
  const files = [...walk(join(root, 'apps/api/src')), ...walk(join(root, 'packages/db/src'))];
  for (const f of files) {
    if (f.includes('/schema/')) continue;
    const src = readFileSync(f, 'utf8');
    // { entity: 'x', entityId: ..., action: cond ? 'a' : 'b', ... }
    for (const m of src.matchAll(/\bentity:\s*([^\n]+)\n[\s\S]{0,200}?\baction:\s*([^\n]+)/g)) {
      for (const w of words(m[1] ?? '')) entities.add(w);
      for (const w of words(m[2] ?? '')) actions.add(w);
    }
    // Raw SQL: INSERT INTO audit (...) SELECT|VALUES <id>, <user>, 'entity', <id>, 'action'
    for (const m of src.matchAll(
      /INSERT INTO audit \([^)]*\)\s*(?:SELECT|VALUES \()\s*[^,]+,\s*[^,]+,\s*'([a-z_]+)',\s*[^,]+,\s*'([a-z_]+)'/g,
    )) {
      entities.add(m[1] as string);
      actions.add(m[2] as string);
    }
  }
  return { entities, actions };
}

describe('audit labels cover every audited entity and action', () => {
  const { entities, actions } = collect();
  it('finds the audit calls', () => {
    expect(entities.size).toBeGreaterThan(20);
    expect(actions.size).toBeGreaterThan(20);
    expect(actions.has('share_parent_link')).toBe(true);
  });
  for (const [lang, msgs] of [
    ['en', en],
    ['ur', ur],
  ] as const) {
    it(`${lang}: every entity and action has a label`, () => {
      const a = msgs.money.audit as unknown as {
        entities: Record<string, string>;
        actions: Record<string, string>;
      };
      expect([...entities].filter((e) => !a.entities[e]).sort()).toEqual([]);
      expect([...actions].filter((x) => !a.actions[x]).sort()).toEqual([]);
    });
  }
});
