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
student.read             all          all          all               own_groups    own_children
student.write            all          all          all               -             -
attendance.mark          all          all          -                 own_groups    -
attendance.correct       all          all          -                 -             -
attendance.read          all          all          -                 own_groups    own_children
fee.generate             all          all          -                 -             -
fee.concession           all          all          -                 -             -
receipt.create           all          all          all               -             -
receipt.reverse          all          all          -                 -             -
cash_session.close_own   own_only     own_only     own_only          -             -
cash_session.reopen_any  all          all          -                 -             -
expense.create           all          all          all               -             -
expense.void             all          all          -                 -             -
payslip.read             all          all          all_except_owner  own_only      -
payslip.approve          all          all          -                 -             -
payslip.pay              all          all          all               -             -
exam.marks_entry         all          all          -                 own_subjects  -
exam.read                all          all          -                 own_groups    own_children
send_queue.use           all          all          all               own_groups    -
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

/** Every registered route × every role, over HTTP. Allowed = anything but 401/403. */
const ROUTE_SNAPSHOT: Record<string, Record<PrincipalRole | 'anonymous', 'allow' | 'deny'>> = {
  'GET /api/health': {
    anonymous: 'allow',
    owner: 'allow',
    admin: 'allow',
    accountant: 'allow',
    teacher: 'allow',
    parent: 'allow',
  },
  'GET /api/auth/google/start': {
    anonymous: 'allow',
    owner: 'allow',
    admin: 'allow',
    accountant: 'allow',
    teacher: 'allow',
    parent: 'allow',
  },
  'GET /api/auth/google/callback': {
    anonymous: 'allow',
    owner: 'allow',
    admin: 'allow',
    accountant: 'allow',
    teacher: 'allow',
    parent: 'allow',
  },
  'POST /api/auth/logout': {
    anonymous: 'allow',
    owner: 'allow',
    admin: 'allow',
    accountant: 'allow',
    teacher: 'allow',
    parent: 'allow',
  },
  'GET /api/me': {
    anonymous: 'deny',
    owner: 'allow',
    admin: 'allow',
    accountant: 'allow',
    teacher: 'allow',
    parent: 'deny',
  },
};

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
    const cookies = new Map<string, string>();
    for (const r of STAFF_ROLES) cookies.set(r, (await signedInAs(db, [r])).cookie);

    for (const spec of routes.list()) {
      const want = ROUTE_SNAPSHOT[`${spec.method} ${spec.path}`];
      expect(want).toBeDefined();
      if (!want) continue;
      for (const who of ['anonymous', ...STAFF_ROLES] as const) {
        const cookie = cookies.get(who);
        const res = await request(spec.path, {
          method: spec.method,
          headers: cookie ? { cookie } : {},
        });
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
