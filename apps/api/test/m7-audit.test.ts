import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { signedInAs, testApp } from './helpers';

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
  const t = testApp();
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
  return { ...t, api, owner, teacher, acct, gA, gB, a, b, ra, rb, bank, st };
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

/** List routes are also tried with the query their screens send, so a 400 is not a free pass. */
const withQueries = (paths: string[], groups: string[] = []) =>
  paths.flatMap((p) =>
    p.includes(':')
      ? [p]
      : [
          p,
          `${p}?period=${period}`,
          `${p}?date=${today}`,
          `${p}?from=${period}-01&to=${today}`,
          ...groups.map((g) => `${p}?grp_id=${g}&month=${period}&date=${today}`),
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
    const open = new Set(['GET /api/p', 'POST /api/p/gate', 'GET /api/p/receipt/:no']);
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
    const ids = [
      f.b.family_id,
      f.b.student_id,
      f.b.guardian_ids[0] as string,
      f.gB.id,
      f.rb.id,
      f.rb.receipt_no,
    ];
    let checked = 0;
    const ok: string[] = [];
    for (const r of f.routes.list().filter((x) => x.method === 'GET')) {
      for (const path of withQueries(fill(r.path, ids), [f.gA.id, f.gB.id])) {
        const res = await teacher('GET', path);
        checked++;
        if (res.status >= 400) continue;
        ok.push(r.path);
        for (const s of secrets)
          expect(res.text.includes(s), `teacher GET ${path} leaks ${s}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(100);
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
    // …while their own group's data is there (the test would pass vacuously otherwise).
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
      for (const path of withQueries(fill(r.path, [ownerSlip, ownerDrawer, f.st.own]))) {
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

describe('M7 audit: publicRoute allow-list (grep)', () => {
  it('only health, the OAuth routes, logout and /api/backup/runs are publicRoute', () => {
    const dir = join(__dirname, '../src/routes');
    const found: string[] = [];
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), 'utf8');
      // Each `access: publicRoute` with the path declared just before it.
      for (const m of src.matchAll(/path: '([^']+)',\s*access: publicRoute/g))
        found.push(`${file} ${m[1]}`);
      const uses = src.match(/access: publicRoute/g)?.length ?? 0;
      const named = [...src.matchAll(/path: '([^']+)',\s*access: publicRoute/g)].length;
      expect(uses, `${file}: publicRoute without an adjacent path`).toBe(named);
    }
    // The parent routes are not on this list: they go through parent_page.view ('public' grant)
    // and check the link token themselves (permissions.test.ts pins that set).
    expect(found.sort()).toEqual(
      [
        'auth.ts /api/auth/google/callback',
        'auth.ts /api/auth/google/start',
        'auth.ts /api/auth/logout',
        'backup.ts /api/backup/runs',
        'core.ts /api/health',
      ].sort(),
    );
  });
});
