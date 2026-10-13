import {
  type AdmissionResult,
  type FamilyStatementDto,
  type FeeHeadDto,
  type GroupDto,
  MATRIX,
  newId,
  PARENT_TOKEN_HEADER,
  type ParentLinkCreatedDto,
  type ProgrammeDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { fakeR2, signedInAs, testApp } from './helpers';

// M7 permission audit (PLAN §10, §15 M7): every registered route × every role, a parent-token
// column over HTTP, and row scope on every read that returns people or money — teachers see only
// their own groups, accountants never the owner's pay or another collector's drawer.

type Res = { status: number; text: string; body: unknown };
function client(request: ReturnType<typeof testApp>['request'], headers: Record<string, string>) {
  return async <T = unknown>(method: string, path: string, body?: unknown) => {
    const res = await request(path, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, text, body: parsed as T } as Res & { body: T };
  };
}

const RS = (n: number) => n * 100;
const today = todayPk();
const period = today.slice(0, 7);
const year = Number(today.slice(0, 4));

/** Two groups, a teacher on one, two families (one per group) with one receipt each. */
async function fixture() {
  const r2 = fakeR2();
  const t = testApp({ env: { FILES: r2.bucket } });
  const owner = await signedInAs(t.db, ['owner']);
  const teacher = await signedInAs(t.db, ['teacher']);
  const acct = await signedInAs(t.db, ['accountant']);
  const api = client(t.request, { cookie: owner.cookie });
  await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school', receipt_prefix: 'AN' });
  await api('POST', '/api/sessions', {
    name: 'S',
    start_date: `${year - 1}-01-01`,
    end_date: `${year + 1}-12-31`,
  });
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const p5 = progs.body.items.find((p) => p.name === 'Class 5')?.id as string;
  const gA = (await api<GroupDto>('POST', '/api/groups', { programme_id: p5, name: '5-A' })).body;
  const gB = (await api<GroupDto>('POST', '/api/groups', { programme_id: p5, name: '5-B' })).body;
  const st = { own: newId(), t: newId(), acc: newId() };
  await t.db.run(sql`INSERT INTO staff (id, user_id, name, role) VALUES
    (${st.own}, ${owner.userId}, 'Owner', 'principal'),
    (${st.t}, ${teacher.userId}, 'Teacher A', 'teacher'),
    (${st.acc}, ${acct.userId}, 'Accountant', 'accountant')`);
  expect((await api('PATCH', `/api/groups/${gA.id}`, { class_teacher_id: st.t })).status).toBe(200);
  const tui = (
    await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', {
      name: 'Tuition',
      kind: 'tuition',
      cadence: 'monthly',
    })
  ).body.head;
  await api('POST', '/api/fees/rates', {
    fee_head_id: tui.id,
    programme_id: p5,
    amount: RS(3000),
    effective_from: `${year - 1}-01-01`,
  });
  await t.db.run(sql`UPDATE school SET setup_completed_at = ${today}`);
  const bank = (
    await api<{ account: { id: string } }>('POST', '/api/accounts', { name: 'HBL', kind: 'bank' })
  ).body.account.id;

  const admit = async (name: string, grp: string, phone: string, dob: string) => {
    const r = await api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: `${name} family` },
      guardians: [{ name: `${name} father`, relation: 'father', phone, consent_whatsapp: true }],
      student: { name, admission_date: `${period}-01`, dob, b_form: '3520112345671' },
      enrolment: { grp_id: grp, start_date: `${period}-01` },
      fees: { charge: true },
    });
    expect(r.status, r.text).toBe(201);
    return r.body;
  };
  const a = await admit('Ali', gA.id, '0300-1111111', '2015-03-01');
  const b = await admit('Bilal', gB.id, '0333-7654321', '2014-05-02');
  const pay = async (family: string, amount: number) => {
    const st = await api<FamilyStatementDto>('GET', `/api/fees/family/${family}`);
    const r = await api<{ receipt: { id: string; receipt_no: string } }>('POST', '/api/receipts', {
      idempotency_key: `k-${newId()}`,
      payer_id: family,
      amount,
      method: 'bank',
      account_id: bank,
      expected_due_hash: st.body.dues_hash,
    });
    expect(r.status, r.text).toBe(201);
    return r.body.receipt;
  };
  const ra = await pay(a.family_id, RS(1111));
  const rb = await pay(b.family_id, RS(2237));

  // Marked registers for both groups (each child absent), so absence messages are queued for both
  // families: the scope checks below then have rows on both sides to leak (M7a review).
  expect(
    (await api('PUT', '/api/school/attendance', { attendance_mode: 'daily', weekly_off: [] }))
      .status,
  ).toBe(200);
  const mark = async (grp: string, student: string) => {
    const r = await api<{ results: { status: string; register_id?: string }[] }>(
      'POST',
      '/api/attendance/sync',
      [
        {
          client_id: newId(),
          grp_id: grp,
          date: today,
          taken_at: new Date().toISOString(),
          marks: [{ student_id: student, status: 'A' }],
        },
      ],
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.results[0]?.status, r.text).toBe('applied');
    return r.body.results[0]?.register_id as string;
  };
  const regA = await mark(gA.id, a.student_id);
  const regB = await mark(gB.id, b.student_id);
  const msg = async (family: string) =>
    (
      await t.db.all<{ id: string }>(
        sql`SELECT id FROM message WHERE family_id = ${family} AND status = 'queued'`,
      )
    )[0]?.id as string;
  const msgA = await msg(a.family_id);
  const msgB = await msg(b.family_id);
  expect(msgA && msgB, 'both families have a queued absence message').toBeTruthy();
  return {
    ...t,
    r2,
    api,
    owner,
    teacher,
    acct,
    gA,
    gB,
    a,
    b,
    ra,
    rb,
    bank,
    st,
    regA,
    regB,
    msgA,
    msgB,
  };
}

/** Every row of every table (sessions aside: they track last use), to prove a refused write changed nothing. */
async function snapshot(db: ReturnType<typeof testApp>['db']) {
  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('user_session', '__drizzle_migrations', 'd1_migrations') ORDER BY name`,
  );
  const out: Record<string, { n: number; rows: string }> = {};
  for (const { name } of tables) {
    const rows = await db.all(sql`SELECT * FROM ${sql.identifier(name)} ORDER BY rowid`);
    out[name] = { n: rows.length, rows: JSON.stringify(rows) };
  }
  return out;
}

/** Every value of a 0333-7654321 phone a response could carry. */
const phoneForms = (local: string) => {
  const d = local.replace(/\D/g, '');
  return [d, `92${d.slice(1)}`, `+92${d.slice(1)}`, local, `${d.slice(0, 4)} ${d.slice(4)}`];
};

/** Path params filled with `ids` (each GET route is tried with each id that fits). */
function fill(path: string, ids: string[]): string[] {
  if (!path.includes(':')) return [path];
  return ids.map((id) =>
    path
      .replace(/:(id|no)\b/g, id)
      .replace(':key', 'absence')
      .replace(':lang', 'en')
      .replace(':day', today)
      .replace(':date', today),
  );
}

/**
 * List routes are also tried with the query their screens send (and the search / filter params a
 * screen might add: q=, group=, family=), so a 400 is not a free pass.
 */
const withQueries = (
  paths: string[],
  groups: string[] = [],
  extra: { q?: string[]; families?: string[] } = {},
) =>
  paths.flatMap((p) =>
    p.includes(':')
      ? [p]
      : [
          p,
          `${p}?period=${period}`,
          `${p}?date=${today}`,
          `${p}?from=${period}-01&to=${today}`,
          ...groups.flatMap((g) => [
            `${p}?grp_id=${g}&month=${period}&date=${today}`,
            `${p}?grp_id=${g}`,
            `${p}?grp_id=${g}&period=${period}`,
            `${p}?group=${g}`,
          ]),
          ...(extra.q ?? []).map((q) => `${p}?q=${encodeURIComponent(q)}`),
          ...(extra.families ?? []).flatMap((f) => [`${p}?family=${f}`, `${p}?family_id=${f}`]),
        ],
  );

describe('M7 audit: route grants', () => {
  it('every route declares a grant that exists in the shared MATRIX', () => {
    const { routes } = testApp();
    for (const r of routes.list()) {
      if (r.access.kind === 'public') continue;
      const { resource, action } = r.access.permission;
      const row = (MATRIX as Record<string, Record<string, unknown>>)[resource]?.[action];
      expect(row, `${r.method} ${r.path} -> ${resource}.${action}`).toBeDefined();
    }
  });

  it('a parent link token opens only the /api/p routes; every other route answers it as anonymous', async () => {
    const f = await fixture();
    const link = await f.api<ParentLinkCreatedDto>(
      'POST',
      `/api/guardians/${f.a.guardian_ids[0]}/parent-link`,
      { gate: 'none' },
    );
    expect(link.status, link.text).toBe(201);
    const token = link.body.url.split('#')[1] ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const asParent = client(f.request, { [PARENT_TOKEN_HEADER]: token });
    const anon = client(f.request, {});
    const open = new Set([
      'GET /api/p',
      'POST /api/p/gate',
      'GET /api/p/receipt/:no',
      'GET /api/p/logo',
      'GET /api/p/badge',
    ]);
    const publicRoutes = new Set(
      f.routes
        .list()
        .filter((r) => r.access.kind === 'public')
        .map((r) => `${r.method} ${r.path}`),
    );
    for (const r of f.routes.list()) {
      const key = `${r.method} ${r.path}`;
      if (key === 'POST /api/auth/logout') continue; // no session either way
      const path = fill(r.path, [f.ra.receipt_no])[0] ?? r.path;
      const res = await asParent(r.method, path);
      if (open.has(key)) {
        expect([200, 400, 404], `${key} ${res.text}`).toContain(res.status);
        continue;
      }
      if (publicRoutes.has(key)) continue;
      // Exactly what an anonymous caller gets: the token is not a credential anywhere else.
      expect(res.status, `${key} with a parent token`).toBe((await anon(r.method, path)).status);
      expect([401, 403], key).toContain(res.status);
    }
    // And with the token, the parent page shows only its own family.
    const page = await asParent('GET', '/api/p');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Ali');
    expect(page.text).not.toContain('Bilal');
    expect(page.text).not.toContain(f.b.family_id);
    expect((await asParent('GET', `/api/p/receipt/${f.rb.receipt_no}`)).status).toBe(404);
  });
});

describe('M7 audit: row scope on every read', () => {
  it("a teacher's responses never contain the other group's students, family, phones or money", async () => {
    const f = await fixture();
    const teacher = client(f.request, { cookie: f.teacher.cookie });
    const otherStudent = (
      await f.db.all<{ id: string }>(sql`SELECT id FROM student WHERE family_id = ${f.b.family_id}`)
    )[0]?.id as string;
    const secrets = [
      f.b.family_id,
      f.b.student_id,
      f.b.guardian_ids[0] as string,
      f.gB.id,
      otherStudent,
      'Bilal',
      f.rb.receipt_no,
      String(RS(2237)),
      ...phoneForms('0333-7654321'),
      '3520112345671',
    ];
    secrets.push(f.msgB, f.regB);
    const ids = [
      f.b.family_id,
      f.b.student_id,
      f.b.guardian_ids[0] as string,
      f.gB.id,
      f.rb.id,
      f.rb.receipt_no,
      f.msgB,
      f.regB,
    ];
    let checked = 0;
    const ok: string[] = [];
    for (const r of f.routes.list().filter((x) => x.method === 'GET')) {
      const paths = withQueries(fill(r.path, ids), [f.gA.id, f.gB.id], {
        q: ['Bilal', '0333', '7654321', f.rb.receipt_no],
        families: [f.b.family_id],
      });
      for (const path of paths) {
        const res = await teacher('GET', path);
        checked++;
        if (res.status >= 400) continue;
        ok.push(r.path);
        for (const s of secrets)
          expect(res.text.includes(s), `teacher GET ${path} leaks ${s}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(500);
    // The reads a teacher holds were really exercised (not skipped on a 400).
    for (const p of [
      '/api/students',
      '/api/families',
      '/api/groups',
      '/api/attendance/today',
      '/api/attendance/report',
      '/api/dashboard/today',
      '/api/fees/defaulters',
      '/api/messages',
      '/api/messages/counts',
    ])
      expect(ok, p).toContain(p);
    // …while their own group's data is there (the test would pass vacuously otherwise): their
    // group's queued absence message and register are visible to them.
    const msgs = await teacher('GET', '/api/messages');
    expect(msgs.text).toContain(f.msgA);
    expect(msgs.text).not.toContain(f.msgB);
    const reg = await teacher('GET', `/api/attendance/register?grp_id=${f.gA.id}&date=${today}`);
    expect(reg.status, reg.text).toBe(200);
    expect(reg.text).toContain(f.regA);
    // The owner does see the other side (so the secrets are real).
    const all = await f.api('GET', '/api/messages');
    expect(all.text).toContain(f.msgB);
    const mine = await teacher('GET', `/api/students/${f.a.student_id}`);
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('Ali');
    // Identity numbers are masked even in their own group.
    expect(mine.text).not.toContain('3520112345671');
  });

  it("an accountant never sees the owner's payslip or another collector's drawer", async () => {
    const f = await fixture();
    const acct = client(f.request, { cookie: f.acct.cookie });
    await f.api('POST', '/api/accounts', { name: 'Drawers', kind: 'cash' });
    for (const [id, base] of [
      [f.st.own, RS(91234)],
      [f.st.t, RS(30000)],
      [f.st.acc, RS(25000)],
    ] as const)
      expect(
        (
          await f.api('PUT', `/api/payroll/staff/${id}`, {
            base_salary: base,
            allowances: [],
          })
        ).status,
      ).toBe(200);
    expect((await f.api('POST', '/api/payslips/generate', { period })).status).toBeLessThan(300);
    const ownerSlip = (
      await f.db.all<{ id: string }>(sql`SELECT id FROM payslip WHERE staff_id = ${f.st.own}`)
    )[0]?.id as string;
    expect(ownerSlip).toBeTruthy();
    const drawer = await f.api<{ session: { id: string } }>('POST', '/api/cash/sessions', {
      opening: RS(4321),
    });
    expect(drawer.status, drawer.text).toBe(201);
    const ownerDrawer = drawer.body.session.id;
    const secrets = [ownerSlip, ownerDrawer, String(RS(91234))];
    for (const r of f.routes.list().filter((x) => x.method === 'GET')) {
      const paths = withQueries(fill(r.path, [ownerSlip, ownerDrawer, f.st.own]), [], {
        q: ['payslip', 'Owner', '91234'],
      });
      for (const path of paths) {
        const res = await acct('GET', path);
        if (res.status >= 400) continue;
        for (const s of secrets)
          expect(res.text.includes(s), `accountant GET ${path} leaks ${s}`).toBe(false);
      }
    }
    // Sanity: the accountant does see other staff pay and both families' receipts (scope 'all').
    const slips = await acct('GET', `/api/payslips?period=${period}`);
    expect(slips.text).toContain(f.st.t);
    expect((await acct('GET', `/api/receipts/${f.rb.id}`)).status).toBe(200);
  });
});

describe('M7 audit: writes as a teacher against the other group', () => {
  it('every POST/PUT/PATCH/DELETE with the other group’s ids is refused and changes no row', async () => {
    const f = await fixture();
    const teacher = client(f.request, { cookie: f.teacher.cookie });
    const ids = [
      f.b.family_id,
      f.b.student_id,
      f.b.guardian_ids[0] as string,
      f.gB.id,
      f.rb.id,
      f.msgB,
      f.regB,
    ];
    // The writes a teacher holds (own_groups) get a real body aimed at group B; the rest `{}`.
    const bodies: Record<string, unknown> = {
      'POST /api/attendance/sync': [
        {
          client_id: newId(),
          grp_id: f.gB.id,
          date: today,
          taken_at: new Date().toISOString(),
          marks: [{ student_id: f.b.student_id, status: 'P' }],
        },
      ],
      'POST /api/fees/defaulters/remind': { grp_id: f.gB.id },
      'POST /api/messages/:id/skip': { reason: 'other' },
    };
    const query: Record<string, string> = {
      'POST /api/messages/bulk-text': `?grp_id=${f.gB.id}`,
    };
    const before = await snapshot(f.db);
    let tried = 0;
    for (const r of f.routes.list().filter((x) => x.method !== 'GET')) {
      const key = `${r.method} ${r.path}`;
      if (r.access.kind === 'public' || r.path.startsWith('/api/p')) continue;
      for (const path of fill(r.path, ids)) {
        const res = await teacher(r.method, `${path}${query[key] ?? ''}`, bodies[key] ?? {});
        tried++;
        if (key === 'POST /api/attendance/sync' && res.status === 200) {
          // Per-register answers: every one refused.
          const results = (res.body as { results: { status: string }[] }).results;
          expect(
            results.map((x) => x.status),
            res.text,
          ).toEqual(['rejected']);
          continue;
        }
        if (key === 'POST /api/fees/defaulters/remind' && res.status < 300) {
          expect((res.body as { queued?: number }).queued ?? 0, res.text).toBe(0);
          continue;
        }
        expect([403, 404], `teacher ${r.method} ${path}: ${res.status} ${res.text}`).toContain(
          res.status,
        );
      }
    }
    expect(tried).toBeGreaterThan(150);
    const after = await snapshot(f.db);
    for (const table of Object.keys(before)) {
      expect(after[table]?.n, `${table} row count`).toBe(before[table]?.n);
      expect(after[table]?.rows, `${table} rows`).toBe(before[table]?.rows);
    }
    // Their own group still works with the same calls (the refusals are scope, not a broken body).
    const own = await teacher('POST', `/api/messages/${f.msgA}/skip`, { reason: 'other' });
    expect(own.status, own.text).toBe(200);
  });
});

describe('M7a review probe (folded in)', () => {
  it('teacher: the screens’ own search and filter URLs for the other group leak nothing', async () => {
    const f = await fixture();
    const teacher = client(f.request, { cookie: f.teacher.cookie });
    const leak = /Bilal|0333|7654321/;
    for (const p of [
      '/api/students?q=Bilal',
      `/api/students?group=${f.gB.id}`,
      `/api/students?family=${f.b.family_id}`,
      '/api/families?q=Bilal',
      '/api/families?q=0333',
      '/api/students?q=0333',
      '/api/messages?q=Bilal',
      `/api/messages?grp_id=${f.gB.id}`,
      '/api/fees/search?q=Bilal',
      `/api/fees/defaulters?grp_id=${f.gB.id}`,
      `/api/fees/defaulters?group=${f.gB.id}`,
      `/api/attendance/register?grp_id=${f.gB.id}&date=${today}`,
      '/api/audit?entity=family',
      '/api/imports/students/template.csv',
      `/api/fees/register?grp_id=${f.gB.id}&period=${period}`,
    ]) {
      const r = await teacher('GET', p);
      if (r.status < 400) expect(leak.test(r.text), `${p}: ${r.text.slice(0, 200)}`).toBe(false);
    }
    expect([403, 404]).toContain(
      (await teacher('POST', `/api/messages/bulk-text?grp_id=${f.gB.id}`)).status,
    );
    expect([403, 404]).toContain(
      (
        await teacher('POST', `/api/guardians/${f.b.guardian_ids[0]}/parent-link`, {
          gate: 'none',
        })
      ).status,
    );
    // The parent logo with no token: nothing, and not cacheable.
    const lg = await f.request('/api/p/logo');
    expect(lg.status).toBe(404);
  });
});

describe('M7 audit: publicRoute allow-list (runtime)', () => {
  it('the routes registered as publicRoute are exactly health, the OAuth routes, logout, /api/backup/runs and the school identity', () => {
    const { routes } = testApp();
    const found = routes
      .list()
      .filter((r) => r.access.kind === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    // The parent routes are not on this list: they go through parent_page.view ('public' grant)
    // and check the link token themselves (permissions.test.ts pins that set).
    expect(found).toEqual(
      [
        'GET /api/auth/google/callback',
        'GET /api/auth/google/start',
        'GET /api/health',
        'POST /api/auth/logout',
        'POST /api/backup/runs',
        // M7b: the sign-in page's school name, badge colour and logo (no session there).
        'GET /api/identity',
        'GET /api/identity/logo',
      ].sort(),
    );
  });
});

describe('M7 receipts: parent link on the staff receipt, logo on the parent receipt', () => {
  it("POST /api/receipts/:id/parent-link: the guardian's current link, made once, null for a PIN school", async () => {
    const f = await fixture();
    const first = await f.api<{ url: string | null }>(
      'POST',
      `/api/receipts/${f.ra.id}/parent-link`,
    );
    expect(first.status, first.text).toBe(200);
    expect(first.body.url).toMatch(/^http:\/\/localhost:5173\/p#[A-Za-z0-9_-]{43}$/);
    // The same link again (recomputed, not a new one), and it really opens the family's page.
    const again = await f.api<{ url: string | null }>(
      'POST',
      `/api/receipts/${f.ra.id}/parent-link`,
    );
    expect(again.body.url).toBe(first.body.url);
    const links = await f.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM parent_link`);
    expect(links[0]?.n).toBe(1);
    const page = await f.request('/api/p', {
      headers: { [PARENT_TOKEN_HEADER]: first.body.url?.split('#')[1] ?? '' },
    });
    expect(page.status).toBe(200);
    // Default gate PIN: no link is made without staff choosing a PIN.
    const set = await f.api('PUT', '/api/school/messages', {
      reminder_cooldown_days: 7,
      parent_gate: 'pin',
      announcement_groups_note: null,
    });
    expect(set.status, set.text).toBe(200);
    const pin = await f.api<{ url: string | null }>('POST', `/api/receipts/${f.rb.id}/parent-link`);
    expect(pin.status).toBe(200);
    expect(pin.body.url).toBeNull();
    // …but an existing link is still returned.
    expect(
      (await f.api<{ url: string | null }>('POST', `/api/receipts/${f.ra.id}/parent-link`)).body
        .url,
    ).toBe(first.body.url);
    // Collectors only: the accountant may, a teacher may not.
    const acct = client(f.request, { cookie: f.acct.cookie });
    expect((await acct('POST', `/api/receipts/${f.ra.id}/parent-link`)).status).toBe(200);
    const teacher = client(f.request, { cookie: f.teacher.cookie });
    expect((await teacher('POST', `/api/receipts/${f.ra.id}/parent-link`)).status).toBe(403);
  });

  it('refuses a reversed receipt (409), gives nothing for the reversal row, and audits a share to a guardian without WhatsApp consent', async () => {
    const f = await fixture();
    const nc = await f.api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: 'NoConsent family' },
      guardians: [
        { name: 'NC father', relation: 'father', phone: '0301-2222222', consent_whatsapp: false },
      ],
      student: { name: 'NC', admission_date: `${period}-01`, dob: '2015-01-01' },
      enrolment: { grp_id: f.gA.id, start_date: `${period}-01` },
      fees: { charge: true },
    });
    expect(nc.status, nc.text).toBe(201);
    const st = await f.api<FamilyStatementDto>('GET', `/api/fees/family/${nc.body.family_id}`);
    const rc = await f.api<{ receipt: { id: string } }>('POST', '/api/receipts', {
      idempotency_key: `k-${newId()}`,
      payer_id: nc.body.family_id,
      amount: RS(500),
      method: 'bank',
      account_id: f.bank,
      expected_due_hash: st.body.dues_hash,
    });
    expect(rc.status, rc.text).toBe(201);
    // No consent: staff may still share by hand (consent governs automated sends) — on the record.
    const shared = await f.api<{ url: string | null }>(
      'POST',
      `/api/receipts/${rc.body.receipt.id}/parent-link`,
    );
    expect(shared.status, shared.text).toBe(200);
    expect(shared.body.url).toMatch(/\/p#/);
    const audits = await f.db.all<{ action: string; diff: string; user_id: string }>(
      sql`SELECT action, diff, user_id FROM audit WHERE entity = 'receipt' AND entity_id = ${rc.body.receipt.id}
          AND action = 'share_parent_link'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.user_id).toBe(f.owner.userId);
    expect(JSON.parse(audits[0]?.diff ?? '{}')).toMatchObject({
      after: { guardian_id: nc.body.guardian_ids[0], consent_whatsapp: false },
    });
    // Reversed: refused, and its reversal row yields no link.
    const rev = await f.api<{ reversal: { id: string } }>(
      'POST',
      `/api/receipts/${f.ra.id}/reverse`,
      { reason: 'entered by mistake' },
    );
    expect(rev.status, rev.text).toBeLessThan(300);
    const after = await f.api<{ error: { code: string } }>(
      'POST',
      `/api/receipts/${f.ra.id}/parent-link`,
    );
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('already_reversed');
    const revRow = await f.api<{ url: string | null }>(
      'POST',
      `/api/receipts/${rev.body.reversal.id}/parent-link`,
    );
    expect(revRow.status).toBe(200);
    expect(revRow.body.url).toBeNull();
  });

  it('GET /api/p/logo: token-gated, image only, cacheable; the parent receipt carries its version', async () => {
    const f = await fixture();
    const link = await f.api<{ url: string }>('POST', `/api/receipts/${f.ra.id}/parent-link`);
    const token = link.body.url.split('#')[1] ?? '';
    const gate = await f.request('/api/p/gate', {
      method: 'POST',
      headers: { [PARENT_TOKEN_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify({ birth_year: 2015 }),
    });
    expect(gate.status).toBe(200);
    const { gate_token } = (await gate.json()) as { gate_token: string };
    const asParent = (path: string) =>
      f.request(path, { headers: { [PARENT_TOKEN_HEADER]: token, 'x-parent-gate': gate_token } });
    expect((await asParent('/api/p/logo')).status).toBe(404); // no logo yet
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await f.r2.bucket.put('school/logo-1', png, { httpMetadata: { contentType: 'image/png' } });
    await f.db.run(sql`UPDATE school SET logo_key = 'school/logo-1'`);
    const r = await asParent(`/api/p/receipt/${f.ra.receipt_no}`);
    expect(r.status).toBe(200);
    const v = ((await r.json()) as { school: { logo_v: string | null } }).school.logo_v;
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    const logo = await asParent(`/api/p/logo?v=${v}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(logo.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(png);
    // No token, a bad token: nothing.
    expect((await f.request('/api/p/logo')).status).toBe(404);
    expect(
      (await f.request('/api/p/logo', { headers: { [PARENT_TOKEN_HEADER]: 'x'.repeat(43) } }))
        .status,
    ).toBe(404);
    // A non-image object under the logo key is never served.
    await f.r2.bucket.put('school/logo-1', png, { httpMetadata: { contentType: 'text/html' } });
    expect((await asParent('/api/p/logo')).status).toBe(404);
    // Other /api/p answers stay no-store.
    expect((await asParent('/api/p')).headers.get('cache-control')).toBe('no-store');
  });

  it('GET /api/p/badge (M7b): token-gated SVG from the short name and colour, versioned', async () => {
    const f = await fixture();
    const link = await f.api<{ url: string }>('POST', `/api/receipts/${f.ra.id}/parent-link`);
    const token = link.body.url.split('#')[1] ?? '';
    const asParent = (path: string) =>
      f.request(path, { headers: { [PARENT_TOKEN_HEADER]: token } });
    const page = (await (await asParent('/api/p')).json()) as {
      school: { logo_v: string | null; badge_v: string | null };
    };
    expect(page.school.logo_v).toBeNull();
    expect(page.school.badge_v).toMatch(/^[0-9a-f]{16}$/);
    const badge = await asParent(`/api/p/badge?v=${page.school.badge_v}`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get('content-type')).toBe('image/svg+xml');
    expect(badge.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
    expect(badge.headers.get('content-security-policy')).toContain('sandbox');
    const svg = await badge.text();
    // "Al-Noor" (no short name yet) → "AN"; Maktab teal by default.
    expect(svg).toContain('>AN</text>');
    expect(svg).toContain('#0f766e');
    expect(svg).not.toMatch(/<script|on\w+=/i);
    // A new short name and colour change the drawing and its version.
    await f.db.run(sql`UPDATE school SET short_name = 'GSA', brand_color = 'blue'`);
    const again = (await (await asParent('/api/p')).json()) as { school: { badge_v: string } };
    expect(again.school.badge_v).not.toBe(page.school.badge_v);
    const svg2 = await (await asParent('/api/p/badge')).text();
    expect(svg2).toContain('>GSA</text>');
    expect(svg2).toContain('#1e40af');
    // No token, a bad token: nothing.
    expect((await f.request('/api/p/badge')).status).toBe(404);
    expect(
      (await f.request('/api/p/badge', { headers: { [PARENT_TOKEN_HEADER]: 'x'.repeat(43) } }))
        .status,
    ).toBe(404);
  });
});
