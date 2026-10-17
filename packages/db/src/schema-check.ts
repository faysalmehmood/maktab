/**
 * The trigger/view/index check behind `npm run db:verify` (scripts/verify-db.ts) and the self-hosted
 * server's start-up check (apps/api/src/node.ts). Pure functions over SQL text and sqlite_master rows,
 * so a script, a test and the Node server share one definition. No file system access here.
 */

export type SchemaObject = { type: string; name: string };

const OBJECT_RE = /CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;

/** Every INDEX / TRIGGER / VIEW a piece of SQL creates, in order. */
export function createdObjects(sqlText: string): { kind: string; name: string }[] {
  return [...sqlText.matchAll(OBJECT_RE)].map((m) => ({
    kind: (m[1] ?? '').toUpperCase(),
    name: m[2] ?? '',
  }));
}

/** What packages/db/sql creates (file name -> text): TRIGGER/VIEW must match exactly; INDEX must be present. */
export function expectedObjectsFrom(files: Record<string, string>): SchemaObject[] {
  return Object.values(files)
    .flatMap((t) => createdObjects(t))
    .map((o) => ({ type: o.kind.toLowerCase(), name: o.name }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Differences between the expected set and what sqlite_master holds (empty = healthy). */
export function compareObjects(actual: readonly SchemaObject[], expected: readonly SchemaObject[]) {
  const has = new Set(actual.map((o) => `${o.type}:${o.name}`));
  const want = new Set(expected.map((o) => `${o.type}:${o.name}`));
  const missing = [...want].filter((k) => !has.has(k));
  const extra = [...has].filter(
    (k) => (k.startsWith('trigger:') || k.startsWith('view:')) && !want.has(k),
  );
  return { missing, extra };
}

// `_demo_*`: the public demo's own undo-log triggers (packages/db/src/demo/undo.ts), not the schema's.
export const MASTER_QUERY =
  "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '!_demo!_%' ESCAPE '!' ORDER BY type, name";
