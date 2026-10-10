import {
  type Grant,
  PRINCIPAL_ROLES,
  type PrincipalRole,
  RESOURCES,
  type Resource,
  STAFF_ROLES,
} from '@maktab/shared';
import { describe, expect, it } from 'vitest';
import { decide, grantFor } from '../src/perm/matrix';
import { signedInAs, testApp } from './helpers';

/**
 * PLAN §5.4 as a snapshot. Changing the matrix without changing this table (or vice versa) fails.
 * Columns: owner admin accountant teacher parent. "-" = denied.
 */
const PLAN_TABLE = `
self.read                own_only     own_only     own_only          own_only      -
catalog.read             all          all          all               all           -
student.read             all          all          all               own_groups    own_children
student.write            all          all          all               -             -
attendance.mark          all          all          -                 own_groups    -
attendance.correct       all          all          -                 -             -
attendance.read          all          all          -                 own_groups    own_children
fee.generate             all          all          -                 -             -
fee.concession           all          all          -                 -             -
fee.manage               all          all          -                 -             -
fee.read                 all          all          all               own_groups    -
receipt.create           all          all          all               -             -
receipt.reverse          all          all          -                 -             -
receipt.read             all          all          all               -             -
cash_session.close_own   own_only     own_only     own_only          -             -
cash_session.reopen_any  all          all          -                 -             -
cash_session.read        all          all          own_only          -             -
cash_session.transfer    all          all          all               -             -
expense.create           all          all          all               -             -
expense.void             all          all          -                 -             -
expense.read             all          all          all               -             -
payslip.read             all          all          all_except_owner  own_only      -
payslip.prepare          all          all          all_except_owner  -             -
payslip.approve          all          all          -                 -             -
payslip.pay              all          all          all               -             -
exam.marks_entry         all          all          -                 own_subjects  -
exam.read                all          all          -                 own_groups    own_children
send_queue.use           all          all          all               own_groups    -
message.read             all          all          all               own_groups    -
settings.manage          all          all          -                 -             -
role.manage              all          -            -                 -             -
backup.manage            all          -            -                 -             -
audit.read               all          -            -                 -             -
`;

const expected = new Map<string, Grant[]>(
  PLAN_TABLE.trim()
    .split('\n')
    .map((line) => {
      const [key = '', ...cells] = line.trim().split(/\s+/);
      return [key, cells.map((c) => (c === '-' ? false : (c as Grant)))];
    }),
);

describe('permission matrix', () => {
  it('covers exactly the resources/actions in the snapshot', () => {
    const declared = Object.entries(RESOURCES).flatMap(([r, actions]) =>
      actions.map((a) => `${r}.${a}`),
    );
    expect(declared.sort()).toEqual([...expected.keys()].sort());
  });

  for (const [key, grants] of expected) {
    it(`${key} matches PLAN §5.4`, () => {
      const [resource, action] = key.split('.') as [Resource, never];
      const actual = PRINCIPAL_ROLES.map((role) => grantFor(resource, action, role));
      expect(actual).toEqual(grants);
    });
  }

  it('combines roles by taking the broadest grant', () => {
    expect(decide(['teacher', 'accountant'], { resource: 'payslip', action: 'read' })).toBe(
      'all_except_owner',
    );
    expect(decide(['teacher'], { resource: 'receipt', action: 'create' })).toBe(false);
    expect(decide([], { resource: 'self', action: 'read' })).toBe(false);
  });
});

/**
 * Every registered route × every role, over HTTP. Allowed = anything but 401/403.
 * Columns: anonymous owner admin accountant teacher parent; A = allow, D = deny.
 * Teachers reach student.read routes but only see their own groups (scope tests below / m1 tests).
 * Parents hold attendance.read (own_children) in the matrix but no session yet; the parent column
 * is checked at the decision level.
 */
const ROUTE_TABLE = `
GET    /api/health                               A A A A A A
GET    /api/auth/google/start                    A A A A A A
GET    /api/auth/google/callback                 A A A A A A
POST   /api/auth/logout                          A A A A A A
GET    /api/me                                   D A A A A D
GET    /api/school                               D A A A A D
GET    /api/school/logo                          D A A A A D
GET    /api/sessions                             D A A A A D
GET    /api/terms                                D A A A A D
GET    /api/programmes                           D A A A A D
GET    /api/subjects                             D A A A A D
GET    /api/custom-fields                        D A A A A D
PUT    /api/school                               D A A D D D
POST   /api/school/complete-setup                D A D D D D
POST   /api/school/logo                          D A A D D D
POST   /api/sessions                             D A A D D D
PATCH  /api/sessions/:id                         D A A D D D
POST   /api/sessions/:id/current                 D A A D D D
POST   /api/terms                                D A A D D D
PATCH  /api/terms/:id                            D A A D D D
DELETE /api/terms/:id                            D A A D D D
POST   /api/programmes                           D A A D D D
POST   /api/programmes/seed-pk                   D A A D D D
PATCH  /api/programmes/:id                       D A A D D D
DELETE /api/programmes/:id                       D A A D D D
POST   /api/subjects                             D A A D D D
POST   /api/subjects/seed-pk                     D A A D D D
PATCH  /api/subjects/:id                         D A A D D D
DELETE /api/subjects/:id                         D A A D D D
POST   /api/custom-fields                        D A A D D D
PATCH  /api/custom-fields/:id                    D A A D D D
DELETE /api/custom-fields/:id                    D A A D D D
POST   /api/groups                               D A A D D D
PATCH  /api/groups/:id                           D A A D D D
PUT    /api/groups/:id/subjects                  D A A D D D
GET    /api/staff                                D A A D D D
POST   /api/staff                                D A A D D D
PATCH  /api/staff/:id                            D A A D D D
POST   /api/staff/invite                         D A D D D D
POST   /api/users/:id/disable                    D A D D D D
POST   /api/users/:id/enable                     D A D D D D
PUT    /api/users/:id/roles                      D A D D D D
GET    /api/groups                               D A A A A A
GET    /api/groups/:id                           D A A A A A
GET    /api/families                             D A A A A A
GET    /api/families/:id                         D A A A A A
GET    /api/students                             D A A A A A
GET    /api/students/:id                         D A A A A A
GET    /api/students/:id/photo                   D A A A A A
POST   /api/families                             D A A A D D
PATCH  /api/families/:id                         D A A A D D
POST   /api/guardians                            D A A A D D
PATCH  /api/guardians/:id                        D A A A D D
DELETE /api/guardians/:id                        D A A A D D
PATCH  /api/students/:id                         D A A A D D
POST   /api/students/:id/photo                   D A A A D D
POST   /api/students/:id/status                  D A A A D D
POST   /api/admissions                           D A A A D D
POST   /api/enrolments                           D A A A D D
POST   /api/enrolments/:id/end                   D A A A D D
POST   /api/enrolments/:id/transfer              D A A A D D
GET    /api/imports/students/template.csv        D A A A D D
POST   /api/imports/students                     D A A A D D
POST   /api/attendance/sync                      D A A D A D
POST   /api/attendance/correct                   D A A D D D
GET    /api/attendance/today                     D A A D A A
GET    /api/attendance/register                  D A A D A A
GET    /api/attendance/student/:id               D A A D A A
GET    /api/attendance/report                    D A A D A A
GET    /api/dashboard/today                      D A A D A A
GET    /api/messages                             D A A A A D
GET    /api/holidays                             D A A A A D
POST   /api/holidays                             D A A D D D
DELETE /api/holidays/:date                       D A A D D D
PUT    /api/school/attendance                    D A A D D D
GET    /api/school/fees                          D A A A A D
PUT    /api/school/fees                          D A A D D D
GET    /api/fees/heads                           D A A A A D
POST   /api/fees/heads                           D A A D D D
PATCH  /api/fees/heads/:id                       D A A D D D
GET    /api/fees/rates                           D A A A A D
POST   /api/fees/rates                           D A A D D D
GET    /api/fees/concessions                     D A A A D D
POST   /api/fees/concessions                     D A A D D D
POST   /api/fees/concessions/:id/end             D A A D D D
GET    /api/fees/sponsors                        D A A A D D
POST   /api/fees/sponsors                        D A A D D D
PATCH  /api/fees/sponsors/:id                    D A A D D D
POST   /api/fees/sponsorships                    D A A D D D
POST   /api/fees/sponsorships/:id/end            D A A D D D
GET    /api/fees/sponsors/:id/statement          D A A A D D
POST   /api/fees/opening-balances                D A A D D D
POST   /api/fees/generate                        D A A D D D
GET    /api/fees/runs                            D A A D D D
POST   /api/fees/fines/apply                     D A A D D D
POST   /api/fees/fines/:id/waive                 D A A D D D
POST   /api/fees/regenerate                      D A A D D D
GET    /api/fees/unbilled                        D A A D D D
POST   /api/charges/:id/void                     D A A D D D
GET    /api/fees/defaulters                      D A A A A D
POST   /api/fees/defaulters/remind               D A A A A D
GET    /api/fees/register                        D A A A D D
GET    /api/fees/concessions/register            D A A A D D
GET    /api/fees/search                          D A A A D D
GET    /api/fees/family/:id                      D A A A D D
GET    /api/fees/collection                      D A A A D D
POST   /api/receipts                             D A A A D D
GET    /api/receipts/:id                         D A A A D D
POST   /api/receipts/:id/reverse                 D A A D D D
POST   /api/receipts/:id/notify                  D A A A D D
POST   /api/refunds                              D A A D D D
GET    /api/cash/sessions                        D A A A D D
POST   /api/cash/sessions                        D A A A D D
POST   /api/cash/sessions/:id/close              D A A A D D
POST   /api/cash/sessions/:id/reopen             D A A D D D
POST   /api/transfers                            D A A A D D
GET    /api/accounts                             D A A A D D
POST   /api/accounts                             D A A D D D
GET    /api/admissions/preview-fees              D A A A D D
GET    /api/fees/student/:id                     D A A A D D
GET    /api/dashboard/fees                       D A A A D D
GET    /api/expenses/categories              D A A A D D
GET    /api/expenses                         D A A A D D
GET    /api/reports/expenses                 D A A A D D
POST   /api/expenses                         D A A A D D
POST   /api/expenses/:id/void                D A A D D D
POST   /api/expenses/:id/photo               D A A A D D
GET    /api/expenses/:id/photo               D A A A D D
GET    /api/payroll/staff                    D A A A D D
PUT    /api/payroll/staff/:id                D A A D D D
POST   /api/payslips/generate                D A A A D D
POST   /api/payslips                         D A A A D D
GET    /api/payslips                         D A A A D D
GET    /api/reports/salaries                 D A A A D D
GET    /api/payslips/mine                    D A A A A D
GET    /api/payslips/:id                     D A A A A D
PUT    /api/payslips/:id/lines               D A A A D D
POST   /api/payslips/:id/approve             D A A D D D
POST   /api/payslips/:id/pay                 D A A A D D
POST   /api/payslips/:id/void                D A A D D D
GET    /api/advances                         D A A A D D
GET    /api/reports/advances                 D A A A D D
POST   /api/advances                         D A A A D D
GET    /api/reports/income-expense           D A A A D D
GET    /api/reports/cashbook                 D A A A D D
GET    /api/reports/accounts                 D A A A D D
GET    /api/audit                            D A D D D D
GET    /api/audit/entities                   D A D D D D
GET    /api/dashboard/month                  D A A A D D
`;

type Who = PrincipalRole | 'anonymous';
const WHO: Who[] = ['anonymous', 'owner', 'admin', 'accountant', 'teacher', 'parent'];
const ROUTE_SNAPSHOT: Record<string, Record<Who, 'allow' | 'deny'>> = Object.fromEntries(
  ROUTE_TABLE.trim()
    .split('\n')
    .map((line) => {
      const [method = '', path = '', ...cells] = line.trim().split(/\s+/);
      const row = Object.fromEntries(
        WHO.map((w, i) => [w, cells[i] === 'A' ? 'allow' : 'deny']),
      ) as Record<Who, 'allow' | 'deny'>;
      return [`${method} ${path}`, row];
    }),
);

describe('route × role', () => {
  it('every registered route has a declared permission and a snapshot row', () => {
    const { app, routes } = testApp();
    const declared = routes.list().map((r) => `${r.method} ${r.path}`);
    expect(declared.sort()).toEqual(Object.keys(ROUTE_SNAPSHOT).sort());
    const mounted = app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'))
      .map((r) => `${r.method} ${r.path}`);
    for (const m of mounted) expect(declared, `${m} mounted without a declaration`).toContain(m);
  });

  it('allows and denies exactly as the snapshot says', async () => {
    const { routes, db, request } = testApp();
    for (const spec of routes.list()) {
      // Fresh sessions per route: POST /api/auth/logout ends the session it is called with.
      const cookies = new Map<string, string>();
      for (const r of STAFF_ROLES) cookies.set(r, (await signedInAs(db, [r])).cookie);
      const want = ROUTE_SNAPSHOT[`${spec.method} ${spec.path}`];
      expect(want).toBeDefined();
      if (!want) continue;
      for (const who of ['anonymous', ...STAFF_ROLES] as const) {
        const cookie = cookies.get(who);
        const res = await request(spec.path, {
          method: spec.method,
          headers: cookie ? { cookie } : {},
        });
        // Allowed must still mean "handled": a crash is a bug, not an allow (501 = no R2 bound).
        if (res.status !== 501) {
          expect(res.status, `${who} ${spec.method} ${spec.path}`).toBeLessThan(500);
        }
        const got = res.status === 401 || res.status === 403 ? 'deny' : 'allow';
        expect(got, `${who} ${spec.method} ${spec.path} -> ${res.status}`).toBe(want[who]);
      }
      // Parents never hold a session (magic links come later), so their column is checked at the
      // decision level against the same snapshot.
      const parent =
        spec.access.kind === 'public' || decide(['parent'], spec.access.permission) !== false
          ? 'allow'
          : 'deny';
      expect(parent, `parent ${spec.method} ${spec.path}`).toBe(want.parent);
    }
  });

  it('denies an endpoint mounted without a declaration (default deny)', async () => {
    const { app, db, request } = testApp();
    app.get('/api/sneaky', (c) => c.text('leaked'));
    const { cookie } = await signedInAs(db, ['owner']);
    const res = await request('/api/sneaky', { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'undeclared_route', message: 'Route has no declared permission' },
    });
  });

  it('a user with no roles is denied, and unknown API paths are JSON 404s', async () => {
    const { db, request } = testApp();
    const { cookie } = await signedInAs(db, []);
    expect((await request('/api/me', { headers: { cookie } })).status).toBe(403);
    const res = await request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
