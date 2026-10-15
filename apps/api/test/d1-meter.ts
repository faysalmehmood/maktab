/**
 * A counting wrapper around a D1 binding: every query's `meta.rows_read` / `rows_written` (what
 * Cloudflare bills against the account's free daily limits), summed per label (the caller sets
 * `meter.label`, e.g. the demo step running) and per statement shape (literals stripped), so the
 * top offenders are visible. Used by d1-demo-reads.test.ts on workerd's real D1 (getPlatformProxy).
 *
 * `raw()` and `first()` return no meta. For a read-only statement the wrapper runs `all()` once to
 * measure it and then the real call (the extra read is not counted); a write through raw()/first()
 * (an INSERT … RETURNING via drizzle's values()) runs once, unmeasured, and is counted in
 * `unmeasured` so a test can insist it stays zero.
 */
export type Stat = { queries: number; read: number; written: number };

type Meta = { rows_read?: number; rows_written?: number };
type Result = { meta?: Meta };
type Stmt = {
  bind: (...v: unknown[]) => Stmt;
  all: () => Promise<Result>;
  run: () => Promise<Result>;
  raw: (o?: unknown) => Promise<unknown[]>;
  first: (col?: string) => Promise<unknown>;
};
type Db = {
  prepare: (q: string) => Stmt;
  batch: (s: Stmt[]) => Promise<Result[]>;
  exec?: (q: string) => Promise<unknown>;
};

const INNER = Symbol('inner');

export function shapeOf(q: string): string {
  return q
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d+(?:\.\d+)?\b/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

const add = (m: Map<string, Stat>, k: string, read: number, written: number) => {
  const s = m.get(k) ?? { queries: 0, read: 0, written: 0 };
  s.queries++;
  s.read += read;
  s.written += written;
  m.set(k, s);
};

export class D1Meter {
  label = 'other';
  byLabel = new Map<string, Stat>();
  byShape = new Map<string, Stat>();
  /** `<label> | <shape>`: which statements make a label dear. */
  byLabelShape = new Map<string, Stat>();
  unmeasured = 0;

  reset(): void {
    this.byLabel.clear();
    this.byShape.clear();
    this.byLabelShape.clear();
    this.unmeasured = 0;
    this.label = 'other';
  }

  total(): Stat {
    const t = { queries: 0, read: 0, written: 0 };
    for (const s of this.byLabel.values()) {
      t.queries += s.queries;
      t.read += s.read;
      t.written += s.written;
    }
    return t;
  }

  /** Sum of the labels for which `pick` is true. */
  sum(pick: (label: string) => boolean): Stat {
    const t = { queries: 0, read: 0, written: 0 };
    for (const [k, s] of this.byLabel)
      if (pick(k)) {
        t.queries += s.queries;
        t.read += s.read;
        t.written += s.written;
      }
    return t;
  }

  top(m: Map<string, Stat>, n: number): [string, Stat][] {
    return [...m].sort((a, b) => b[1].read - a[1].read).slice(0, n);
  }

  private record(q: string, meta: Meta | undefined): void {
    const read = meta?.rows_read ?? 0;
    const written = meta?.rows_written ?? 0;
    add(this.byLabel, this.label, read, written);
    add(this.byShape, shapeOf(q), read, written);
    add(this.byLabelShape, `${this.label} | ${shapeOf(q)}`, read, written);
  }

  wrap<T>(db: T): T {
    const inner = db as unknown as Db;
    const wrapStmt = (q: string, s: Stmt): Stmt => {
      const readOnly = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i.test(q);
      const w: Stmt & { [INNER]: Stmt } = {
        [INNER]: s,
        bind: (...v) => wrapStmt(q, s.bind(...v)),
        all: async () => {
          const r = await s.all();
          this.record(q, r.meta);
          return r;
        },
        run: async () => {
          const r = await s.run();
          this.record(q, r.meta);
          return r;
        },
        raw: async (o) => {
          if (readOnly) this.record(q, (await s.all()).meta);
          else this.unmeasured++;
          return s.raw(o);
        },
        first: async (col) => {
          if (readOnly) this.record(q, (await s.all()).meta);
          else this.unmeasured++;
          return s.first(col);
        },
      };
      return w;
    };
    const wrapped: Db = {
      prepare: (q) => wrapStmt(q, inner.prepare(q)),
      batch: async (stmts) => {
        const raw = stmts.map((s) => (s as Stmt & { [INNER]?: Stmt })[INNER] ?? s);
        const res = await inner.batch(raw);
        res.forEach((r, i) => {
          this.record(sqlOf.get(stmts[i] as Stmt) ?? '(batch)', r.meta);
        });
        return res;
      },
      exec: inner.exec?.bind(inner),
    };
    // Remember each wrapped statement's SQL for batch() accounting.
    const prepare = wrapped.prepare;
    wrapped.prepare = (q) => remember(prepare(q), q);
    return wrapped as unknown as T;
  }
}

const sqlOf = new WeakMap<Stmt, string>();
function remember(s: Stmt, q: string): Stmt {
  sqlOf.set(s, q);
  const bind = s.bind;
  s.bind = (...v) => remember(bind(...v), q);
  return s;
}

/** A plain-text table of the top entries, for the test log. */
export function table(rows: [string, Stat][]): string {
  return rows
    .map(
      ([k, s]) =>
        `${String(s.read).padStart(10)} read ${String(s.written).padStart(7)} written ${String(s.queries).padStart(6)} q  ${k}`,
    )
    .join('\n');
}
