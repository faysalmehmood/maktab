import { readFileSync } from 'node:fs';
import { type AppDb, DEMO_USERS, demoStatus, seedDemo } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_LOCKED, demoTick } from '../src/routes/demo';
import { env, ORIGIN, PARENT_SECRET, SECRET, signedInAs, testApp } from './helpers';

/** The keys of each `[section]` of wrangler.toml (a line-level reader; enough for vars). */
function tomlSections(): Map<string, Map<string, string>> {
  const text = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const out = new Map<string, Map<string, string>>([['', new Map()]]);
  let cur = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const head = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (head) {
      cur = head[1] as string;
      if (!out.has(cur)) out.set(cur, new Map());
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (kv) out.get(cur)?.set(kv[1] as string, (kv[2] as string).replace(/^"|"$/g, ''));
  }
  return out;
}

describe('wrangler.toml', () => {
  const s = tomlSections();
  it('DEMO_MODE is set only on the demo environment, never on a real school', () => {
    const withDemo = [...s].filter(([, kv]) => kv.has('DEMO_MODE')).map(([k]) => k);
    expect(withDemo).toEqual(['env.demo.vars']);
    expect(s.get('env.demo.vars')?.get('DEMO_MODE')).toBe('1');
    expect(s.get('env.gsap.vars')?.has('DEMO_MODE')).toBe(false);
    expect(s.get('vars')?.has('DEMO_MODE')).toBe(false);
    // The old production environment is gone: nothing can deploy the demo flag elsewhere by name.
    expect(s.has('env.production')).toBe(false);
  });

  it('the GSA pilot and the demo use different databases and file buckets', () => {
    const raw = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const block = (env: string) => raw.slice(raw.indexOf(`\n[env.${env}]`));
    const db = (env: string) => /database_name = "([^"]+)"/.exec(block(env))?.[1];
    expect(db('gsap')).toBe('maktab-gsap');
    expect(db('demo')).toBe('maktab');
    expect(s.get('env.gsap')?.get('name')).toBe('maktab-gsap');
    expect(s.get('env.demo')?.get('name')).toBe('maktab');
    // The demo is never backed up: no BACKUPS binding in its block (gsap keeps it).
    const demoBlock = raw.slice(raw.indexOf('\n[env.demo]'), raw.indexOf('\n[env.gsap]'));
    expect(demoBlock).not.toMatch(/BACKUPS/);
    expect(block('gsap')).toMatch(/binding = "BACKUPS"/);
  });
});

describe('without DEMO_MODE the demo does not exist', () => {
  it('answers 404 for every demo route and the identity has no demo flag', async () => {
    const { request, routes } = testApp();
    expect(routes.list().some((r) => r.path.includes('demo'))).toBe(false);
    for (const [method, path] of [
      ['POST', '/api/auth/demo'],
      ['GET', '/api/demo'],
      ['POST', '/api/demo/reset'],
      ['POST', '/api/demo/step'],
    ] as const) {
      const res = await request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ as: 'principal' }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const id = (await (await request('/api/identity')).json()) as Record<string, unknown>;
    expect(id).not.toHaveProperty('demo');
  });

  it('a locked route works normally (no demo_locked) outside demo mode', async () => {
    const { request, db } = testApp();
    const owner = await signedInAs(db, ['owner']);
    const res = await request('/api/parent-links/rotate-all', {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(403);
  });
});

describe('DEMO_MODE=1', () => {
  let db: AppDb;
  const demoEnv = {
    DEMO_MODE: '1',
    OWNER_EMAIL: 'owner@example.com',
    PARENT_LINK_SECRET: PARENT_SECRET,
  };
  beforeAll(async () => {
    db = createTestDb();
    await seedDemo(db, { parentSecret: PARENT_SECRET, ownerEmail: 'owner@example.com' });
  }, 180_000);
  const app = () => testApp({ db, demo: true, env: demoEnv });
  const signIn = async (as: string) =>
    app().request('/api/auth/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ as }),
    });
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string;

  it('identity carries demo: true (the sign-in page shows the buttons)', async () => {
    const body = (await (await app().request('/api/identity')).json()) as {
      demo?: boolean;
      school: { name: string };
    };
    expect(body.demo).toBe(true);
    expect(body.school.name).toBe('Al-Noor Community School');
  });

  it('each demo button mints a session for its fixed user, with that user’s roles', async () => {
    const want = { principal: 'owner', accountant: 'accountant', teacher: 'teacher' } as const;
    for (const [as, role] of Object.entries(want)) {
      const res = await signIn(as);
      expect(res.status, as).toBe(200);
      const cookie = cookieOf(res);
      expect(cookie).toMatch(/^maktab_sid=/);
      const me = (await (await app().request('/api/me', { headers: { cookie } })).json()) as {
        user: { email: string };
        roles: string[];
      };
      expect(me.user.email).toBe(DEMO_USERS[as as keyof typeof DEMO_USERS]);
      expect(me.roles).toContain(role);
    }
    expect((await signIn('admin')).status).toBe(400);
    expect((await signIn('owner')).status).toBe(400);
  });

  it('demo sign-in is rate limited per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++)
      statuses.push(
        (
          await app().request('/api/auth/demo', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'cf-connecting-ip': '203.0.113.77',
              origin: ORIGIN,
            },
            body: JSON.stringify({ as: 'teacher' }),
          })
        ).status,
      );
    expect(statuses).toContain(429);
  });

  it('installation settings answer 403 demo_locked, even for the principal (an owner)', async () => {
    const cookie = cookieOf(await signIn('principal'));
    const someone = (await db.all<{ id: string }>(sql`SELECT id FROM "user" LIMIT 1`))[0]?.id;
    const calls: [string, string, unknown][] = [
      ['POST', '/api/parent-links/rotate-all', {}],
      ['POST', '/api/staff/invite', { email: 'x@example.com', roles: ['teacher'] }],
      ['PUT', `/api/users/${someone}/roles`, { roles: ['owner'] }],
      ['POST', `/api/users/${someone}/disable`, {}],
      ['POST', '/api/backup/export', {}],
      ['POST', '/api/backup/drills', {}],
    ];
    for (const [method, path, body] of calls) {
      const res = await app().request(path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('demo_locked');
    }
    expect(DEMO_LOCKED.length).toBeGreaterThanOrEqual(6);
  });

  it('caps uploads at 200 KB', async () => {
    const cookie = cookieOf(await signIn('principal'));
    const res = await app().request('/api/school/logo', {
      method: 'POST',
      headers: {
        cookie,
        'content-length': String(300 * 1024),
        'content-type': 'multipart/form-data; boundary=x',
      },
      body: 'x',
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('demo_upload_cap');
  });

  it('a visitor’s write marks the demo dirty (the nightly reset then runs)', async () => {
    await db.run(sql`UPDATE _demo_state SET value = '0' WHERE key = 'dirty'`);
    const cookie = cookieOf(await signIn('principal'));
    expect((await demoStatus(db)).dirty).toBe(false);
    const fam = (await db.all<{ id: string }>(sql`SELECT id FROM family LIMIT 1`))[0]?.id;
    const res = await app().request(`/api/families/${fam}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ area: 'Johar Town' }),
    });
    expect(res.status).toBeLessThan(400);
    expect((await demoStatus(db)).dirty).toBe(true);
  });

  it('only the installation owner (OWNER_EMAIL) may reset; a demo principal gets demo_locked', async () => {
    const demoOwner = cookieOf(await signIn('principal'));
    const res = await app().request('/api/demo/reset', {
      method: 'POST',
      headers: { cookie: demoOwner, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('demo_locked');
    const teacher = cookieOf(await signIn('teacher'));
    expect(
      (
        await app().request('/api/demo/reset', {
          method: 'POST',
          headers: { cookie: teacher, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });

  it('the step route does nothing on a seeded demo; the cron tick idles outside 02:00', async () => {
    const res = await app().request('/api/demo/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { phase: string }).phase).toBe('done');
    // 10:00 Karachi, dirty: no reset now (it waits for 02:00).
    await db.run(sql`UPDATE _demo_state SET value = '1' WHERE key = 'dirty'`);
    expect(await demoTick(db, { ...env, ...demoEnv }, Date.parse('2026-10-14T05:00:00Z'))).toBe(
      false,
    );
    expect((await demoStatus(db)).phase).toBe('done');
  });

  it('the owner’s reset (and the 02:00 tick) wipe and reseed, ending on the same school', async () => {
    const before = await db.all(sql`SELECT count(*) AS n, sum(amount) AS s FROM receipt`);
    const owner = await signedInAs(db, ['owner'], 'owner2@example.com');
    // The real owner is OWNER_EMAIL; owner2 is just another owner and is refused.
    expect(
      (
        await app().request('/api/demo/reset', {
          method: 'POST',
          headers: { cookie: owner.cookie, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    // 02:00 Karachi with the demo dirty: the tick starts the nightly reset and drives it.
    await db.run(sql`UPDATE _demo_state SET value = '1' WHERE key = 'dirty'`);
    const at = Date.parse('2026-10-14T21:00:30Z');
    expect(await demoTick(db, { ...env, ...demoEnv }, at)).toBe(true);
    for (let i = 0; i < 200 && (await demoStatus(db)).phase === 'running'; i++)
      await demoTick(db, { ...env, ...demoEnv }, at + i * 60_000);
    const s = await demoStatus(db);
    expect(s.phase).toBe('done');
    expect(s.dirty).toBe(false);
    expect(await db.all(sql`SELECT count(*) AS n, sum(amount) AS s FROM receipt`)).toEqual(before);
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    // Same day again: no second reset even if dirty.
    await db.run(sql`UPDATE _demo_state SET value = '1' WHERE key = 'dirty'`);
    expect(await demoTick(db, { ...env, ...demoEnv }, at + 10 * 60_000)).toBe(false);
    expect(SECRET.length).toBeGreaterThan(31);
  }, 180_000);
});
