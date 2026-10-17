import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { role, user } from '@maktab/db';
import { D1_MIGRATIONS_TABLE, MIGRATIONS_DIR, migrationNames } from '@maktab/db/node';
import { newId, type StaffRole } from '@maktab/shared';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, SPA_HEADERS } from '../src/app';
import { signSession } from '../src/auth/signed';
import { createSession } from '../src/auth/signin';
import {
  ConfigError,
  loadConfig,
  RUN_WORKER_FIRST,
  type RunningServer,
  runsWorkerFirst,
  startServer,
} from '../src/node';
import { logErrorLine, safeErrorLine } from '../src/node/log';
import { chooseClientIp, isLoopback, parseTrustedProxies } from '../src/node/proxy';
import { headersFor, parseHeadersFile } from '../src/node/static';
import { REPORT_TOKEN, SECRET } from './helpers';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const HEADERS_SRC = here('../../web/public/_headers');

/** A small stand-in for apps/web/dist (CI runs the tests before the web build). */
function fakeWebDir(root: string): string {
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  mkdirSync(join(web, 'icons'), { recursive: true });
  writeFileSync(
    join(web, 'index.html'),
    '<!doctype html><title>Maktab</title><div id="root"></div>',
  );
  writeFileSync(join(web, 'assets', 'index-AbCd1234.js'), 'console.log(1)');
  writeFileSync(join(web, 'assets', 'other-AbCd1234.js'), 'console.log(2)');
  writeFileSync(join(web, 'manifest.webmanifest'), '{}');
  writeFileSync(join(web, 'icons', 'icon.svg'), '<svg/>');
  writeFileSync(join(web, '.secret'), 'never served');
  copyFileSync(HEADERS_SRC, join(web, '_headers'));
  return web;
}

type Raw = { status: number; headers: Headers; text: string };

/**
 * node:http, not fetch: undici always sends its own `Sec-Fetch-Mode: cors`, and these tests must
 * control every header (and the body framing).
 */
function raw(
  url: string,
  o: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
    chunks?: (Uint8Array | string)[];
  } = {},
): Promise<Raw> {
  return new Promise((done, fail) => {
    // agent: false: a fresh connection each time (the server closes one after an early 413).
    const req = request(
      url,
      { method: o.method ?? 'GET', headers: o.headers ?? {}, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === 'string') h.set(k, v);
            else if (Array.isArray(v)) for (const x of v) h.append(k, x);
          done({
            status: res.statusCode ?? 0,
            headers: h,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', fail);
    if (o.chunks) for (const c of o.chunks) req.write(c);
    else if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const baseEnv = (
  dataDir: string,
  webDir: string,
  extra: Record<string, string | undefined> = {},
) => ({
  SESSION_SECRET: SECRET,
  PARENT_LINK_SECRET: 'p'.repeat(40),
  APP_ORIGIN: 'http://localhost:5173',
  OWNER_EMAIL: 'owner@example.com',
  BACKUP_REPORT_TOKEN: REPORT_TOKEN,
  DATA_DIR: dataDir,
  WEB_DIR: webDir,
  PORT: '0',
  HOST: '127.0.0.1',
  MAKTAB_SCHEDULER: '0',
  MAKTAB_VERSION: 'test-1',
  ALLOW_UNENCRYPTED_BACKUPS: '1',
  ...extra,
});

async function sessionCookie(srv: RunningServer, roles: StaffRole[], https = false) {
  const id = newId();
  await srv.db
    .insert(user)
    .values({ id, email: `${id}@example.com`, name: 'Owner', status: 'active' });
  await srv.db.insert(role).values(roles.map((r) => ({ userId: id, role: r })));
  const s = await createSession(srv.db, newId(), id, { ua: null, ip: null, nowMs: Date.now() });
  return `${https ? '__Host-' : ''}maktab_sid=${await signSession(SECRET, s.id, s.exp)}`;
}

async function multipart(bytes: Uint8Array, type: string) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], 'logo.png', { type }));
  const req = new Request('http://x/', { method: 'POST', body: form });
  return {
    body: new Uint8Array(await req.arrayBuffer()),
    type: req.headers.get('content-type') ?? '',
  };
}

const png = (size: number) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};

describe('self-hosted Node server', () => {
  let root: string;
  let srv: RunningServer;
  let base: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'maktab-node-'));
    const web = fakeWebDir(root);
    const recipient = await identityToRecipient(await generateX25519Identity());
    srv = await startServer(
      loadConfig(
        baseEnv(join(root, 'data'), web, {
          ALLOW_UNENCRYPTED_BACKUPS: undefined,
          AGE_RECIPIENT: recipient,
          TRUST_PROXY_FROM: '127.0.0.1',
        }),
      ),
    );
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /healthz: status and db; the version only for a loopback peer', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', db: 'ok', version: 'test-1' });
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('172.18.0.3')).toBe(false);
  });

  it('serves index.html with every _headers rule; the CSP is literally app.ts SPA_HEADERS', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await r.text()).toContain('<div id="root">');
    const expected = headersFor(parseHeadersFile(readFileSync(HEADERS_SRC, 'utf8')), '/');
    expect([...expected.keys()].length).toBeGreaterThanOrEqual(5);
    for (const [k, v] of expected) expect(r.headers.get(k)).toBe(v);
    for (const [k, v] of Object.entries(SPA_HEADERS)) expect(r.headers.get(k), k).toBe(v);
    expect(r.headers.get('content-security-policy')).toBe(SPA_HEADERS['Content-Security-Policy']);
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  it('hashed assets are immutable; the ETag is the content hash; If-None-Match answers 304', async () => {
    const r = await fetch(`${base}/assets/index-AbCd1234.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = r.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const again = await fetch(`${base}/assets/index-AbCd1234.js`, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    // Same size, other bytes: another ETag. Same bytes with a new mtime: the same ETag.
    const other = await fetch(`${base}/assets/other-AbCd1234.js`);
    expect(other.headers.get('etag')).not.toBe(etag);
    const f = join(root, 'web/assets/index-AbCd1234.js');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect((await fetch(`${base}/assets/index-AbCd1234.js`)).headers.get('etag')).toBe(etag);
    writeFileSync(f, 'console.log(3)');
    expect((await fetch(`${base}/assets/index-AbCd1234.js`)).headers.get('etag')).not.toBe(etag);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
  });

  it('SPA fallback like Workers: every unmatched path is index.html (200), whatever the headers', async () => {
    for (const [p, h] of [
      ['/students/abc', { 'sec-fetch-mode': 'navigate' }],
      ['/settings', { accept: 'text/html' }],
      ['/students', {}],
      ['/assets/missing.js', { 'sec-fetch-mode': 'no-cors', accept: '*/*' }],
      ['/api', {}],
      ['/icons/', {}],
      ['/foo.html', {}],
    ] as [string, Record<string, string>][]) {
      const r = await raw(`${base}${p}`, { headers: h });
      expect(r.status, p).toBe(200);
      expect(r.text, p).toContain('<div id="root">');
      expect(r.headers.get('x-frame-options'), p).toBe('DENY');
    }
  });

  it('never serves _headers, dot-files, directory listings or anything outside the web root', async () => {
    for (const p of [
      '/_headers',
      '/.secret',
      '/icons/',
      '/%2e%2e/data/maktab.sqlite',
      '/..%2fdata%2fmaktab.sqlite',
      '/assets/..%2f..%2fdata/maktab.sqlite',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const r = await raw(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.text, p).toContain('<div id="root">');
      expect(r.text).not.toMatch(/SQLite|never served|Content-Security-Policy:|icon\.svg|root:/);
    }
  });

  it('/index and /index.html redirect (307) to /', async () => {
    for (const p of ['/index.html', '/index', '/index?x=1']) {
      const r = await fetch(`${base}${p}`, { redirect: 'manual' });
      expect(r.status, p).toBe(307);
      expect(r.headers.get('location'), p).toBe(p.includes('?') ? '/?x=1' : '/');
    }
  });

  it('GET /api/identity answers from the app (200)', async () => {
    const r = await fetch(`${base}/api/identity`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ school: null });
  });

  it('/__scheduled is not exposed (404), even for a navigation', async () => {
    for (const h of [{}, { 'sec-fetch-mode': 'navigate' }] as Record<string, string>[]) {
      const r = await raw(`${base}/__scheduled`, { headers: h });
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type')).toMatch(/json/);
    }
  });

  it('run_worker_first: /p and /p/* are the app’s parent shell (noindex, no-store, SPA headers)', async () => {
    for (const p of ['/p', '/p/anything']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(r.headers.get('content-security-policy')).toBe(SPA_HEADERS['Content-Security-Policy']);
      expect(await r.text()).toContain('<div id="root">');
    }
  });

  it('a POST body reaches the app (the token-only backup report)', async () => {
    const r = await fetch(`${base}/api/backup/runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${REPORT_TOKEN}`,
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ kind: 'nightly', status: 'ok' }),
    });
    expect(r.status).toBe(201);
  });

  it('upload caps through the listener: Content-Length fast path and a chunked body', async () => {
    srv.sqlite
      .prepare("INSERT INTO school (id, name, weekly_off) VALUES (?, 'T', '[]')")
      .run(newId());
    const cookie = await sessionCookie(srv, ['owner']);
    const url = `${base}/api/school/logo`;
    const send = async (bytes: Uint8Array, chunked: boolean) => {
      const m = await multipart(bytes, 'image/png');
      const headers: Record<string, string> = {
        cookie,
        origin: 'http://localhost:5173',
        'content-type': m.type,
      };
      if (!chunked) headers['content-length'] = String(m.body.byteLength);
      const half = Math.floor(m.body.byteLength / 2);
      return raw(url, {
        method: 'POST',
        headers,
        ...(chunked
          ? { chunks: [m.body.subarray(0, half), m.body.subarray(half)] }
          : { body: m.body }),
      });
    };
    expect((await send(png(1024), false)).status).toBe(200);
    expect((await send(png(1024), true)).status).toBe(200);
    expect((await send(png(512 * 1024 + 1), false)).status).toBe(413);
    expect((await send(png(512 * 1024 + 20 * 1024), true)).status).toBe(413);
    // A chunked body that is endless in spirit: refused once past the cap, not buffered whole.
    const big = new Uint8Array(64 * 1024);
    const r = await raw(url, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost:5173',
        'content-type': 'multipart/form-data; boundary=x',
      },
      chunks: Array.from({ length: 20 }, () => big),
    }).catch(() => ({ status: 413 }) as Raw);
    expect(r.status).toBe(413);
  });

  it('applied every migration with wrangler’s d1_migrations rows, in order; synchronous FULL', () => {
    const rows = srv.sqlite
      .prepare(`SELECT id, name, applied_at FROM ${D1_MIGRATIONS_TABLE} ORDER BY id`)
      .all() as { id: number; name: string; applied_at: string }[];
    expect(rows.map((r) => r.name)).toEqual(migrationNames(MIGRATIONS_DIR));
    expect(rows[0]?.name).toBe('0000_init.sql');
    expect(rows.every((r) => r.applied_at)).toBe(true);
    expect(srv.migrationsApplied).toHaveLength(rows.length);
    // A fresh database: nothing to save before migrating.
    expect(srv.preMigrate).toBeNull();
    expect(srv.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(srv.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(srv.sqlite.pragma('synchronous', { simple: true })).toBe(2);
  });

  it('trusted peer: rate limit keys on its CF-Connecting-IP; X-Forwarded-For is ignored', async () => {
    const hit = (h: Record<string, string>) => raw(`${base}/api/auth/google/start`, { headers: h });
    for (let i = 0; i < 20; i++)
      expect((await hit({ 'cf-connecting-ip': '203.0.113.7' })).status).not.toBe(429);
    expect((await hit({ 'cf-connecting-ip': '203.0.113.7' })).status).toBe(429);
    expect(
      (await hit({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })).status,
    ).toBe(429);
    expect((await hit({ 'cf-connecting-ip': '203.0.113.8' })).status).not.toBe(429);
    // XFF alone (or a list in CF-Connecting-IP) is not a client IP: the peer's own bucket.
    expect((await hit({ 'x-forwarded-for': '203.0.113.7' })).status).not.toBe(429);
    expect((await hit({ 'cf-connecting-ip': '203.0.113.7, 1.2.3.4' })).status).not.toBe(429);
  });
});

describe('untrusted peer (TRUST_PROXY_FROM empty): spoofed headers end to end', () => {
  it('every spoofed CF-Connecting-IP / X-Forwarded-For lands in the socket peer’s one bucket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-spoof-'));
    const srv = await startServer(loadConfig(baseEnv(join(root, 'data'), fakeWebDir(root))));
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) {
        const r = await raw(`${base}/api/auth/google/start`, {
          headers: {
            'cf-connecting-ip': `198.51.100.${i + 1}`,
            'x-forwarded-for': `203.0.113.${i + 1}`,
            'x-real-ip': `192.0.2.${i + 1}`,
            'true-client-ip': `192.0.2.${i + 1}`,
          },
        });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
    } finally {
      await srv.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('client IP choice and TRUST_PROXY_FROM parsing', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const docker = parseTrustedProxies('172.16.0.0/12');
  it('believes CF-Connecting-IP only from a peer inside the list', () => {
    expect(chooseClientIp(h({ 'cf-connecting-ip': '203.0.113.1' }), '172.18.0.5', docker)).toBe(
      '203.0.113.1',
    );
    expect(
      chooseClientIp(h({ 'cf-connecting-ip': '203.0.113.1' }), '::ffff:172.18.0.5', docker),
    ).toBe('203.0.113.1');
    expect(chooseClientIp(h({ 'cf-connecting-ip': '203.0.113.1' }), '10.0.0.9', docker)).toBe(
      '10.0.0.9',
    );
    expect(chooseClientIp(h({ 'x-forwarded-for': '198.51.100.2' }), '172.18.0.5', docker)).toBe(
      '172.18.0.5',
    );
    expect(chooseClientIp(h({ 'cf-connecting-ip': 'evil' }), '172.18.0.5', docker)).toBe(
      '172.18.0.5',
    );
    expect(
      chooseClientIp(h({ 'cf-connecting-ip': '1.2.3.4' }), '172.18.0.5', parseTrustedProxies('')),
    ).toBe('172.18.0.5');
    const v6 = parseTrustedProxies('fd00::/8, 10.1.2.3');
    expect(chooseClientIp(h({ 'cf-connecting-ip': '2001:db8::1' }), 'fd12::5', v6)).toBe(
      '2001:db8::1',
    );
    expect(chooseClientIp(h({ 'cf-connecting-ip': '2001:db8::1' }), '10.1.2.3', v6)).toBe(
      '2001:db8::1',
    );
    expect(chooseClientIp(h({ 'cf-connecting-ip': '2001:db8::1' }), '10.1.2.4', v6)).toBe(
      '10.1.2.4',
    );
  });
  it('parses strictly', () => {
    for (const bad of [
      '10.0.0.0/33',
      'abc',
      '1.2.3.4/8x',
      '10.0.0.0/',
      '::/129',
      '1.2.3',
      '10.0.0.0/-1',
    ])
      expect(() => parseTrustedProxies(bad), bad).toThrow(/TRUST_PROXY_FROM/);
    expect(parseTrustedProxies(' 172.16.0.0/12 ,10.0.0.1 ').entries).toEqual([
      '172.16.0.0/12',
      '10.0.0.1/32',
    ]);
  });
});

describe('https APP_ORIGIN served over plain http (behind the tunnel)', () => {
  it('uses the __Host- Secure cookie and checks CSRF against APP_ORIGIN, not the request URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-https-'));
    const srv = await startServer(
      loadConfig(
        baseEnv(join(root, 'data'), fakeWebDir(root), { APP_ORIGIN: 'https://school.example' }),
      ),
    );
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const cookie = await sessionCookie(srv, ['owner'], true);
      expect(cookie.startsWith('__Host-maktab_sid=')).toBe(true);
      expect((await raw(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
      // The http-origin cookie name is not a session here.
      expect(
        (await raw(`${base}/api/me`, { headers: { cookie: cookie.replace('__Host-', '') } }))
          .status,
      ).toBe(401);
      const post = (origin: string) =>
        raw(`${base}/api/auth/logout`, {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        });
      expect((await post(`http://127.0.0.1:${srv.port}`)).status).toBe(403);
      const ok = await post('https://school.example');
      expect(ok.status).toBeLessThan(400);
      const set = ok.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/__Host-maktab_sid=/);
      expect(set).toMatch(/Secure/i);
    } finally {
      await srv.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('start-up refusals', () => {
  it('refuses DEMO_MODE, bad secrets, a bad APP_ORIGIN, no AGE_RECIPIENT, the old TRUST_PROXY', () => {
    const env = baseEnv('/nonexistent', '/nonexistent');
    expect(() => loadConfig({ ...env, DEMO_MODE: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, DEMO_MODE: '0' })).toThrow(/DEMO_MODE/);
    expect(() => loadConfig({ ...env, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...env, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...env, PARENT_LINK_SECRET: 'short' })).toThrow(/PARENT_LINK_SECRET/);
    expect(loadConfig({ ...env, PARENT_LINK_SECRET: '' }).vars.PARENT_LINK_SECRET).toBeUndefined();
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'https://x.example/path' })).toThrow(/origin/);
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'http://x.example' })).toThrow(/https/);
    expect(() => loadConfig({ ...env, ALLOW_UNENCRYPTED_BACKUPS: undefined })).toThrow(
      /AGE_RECIPIENT/,
    );
    expect(() => loadConfig({ ...env, ALLOW_UNENCRYPTED_BACKUPS: 'yes' })).toThrow(/AGE_RECIPIENT/);
    expect(() => loadConfig({ ...env, AGE_RECIPIENT: 'ssh-ed25519 AAAA' })).toThrow(
      /AGE_RECIPIENT/,
    );
    expect(() => loadConfig({ ...env, TRUST_PROXY: '1' })).toThrow(/TRUST_PROXY_FROM/);
    expect(() => loadConfig({ ...env, TRUST_PROXY_FROM: '10.0.0.0/40' })).toThrow(
      /TRUST_PROXY_FROM/,
    );
    expect(loadConfig(env).vars.APP_ORIGIN).toBe('http://localhost:5173');
  });

  it('refuses to start with an age1… key that does not encrypt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-age-'));
    try {
      const cfg = loadConfig(
        baseEnv(join(root, 'data'), fakeWebDir(root), {
          ALLOW_UNENCRYPTED_BACKUPS: undefined,
          AGE_RECIPIENT: `age1${'q'.repeat(58)}`,
        }),
      );
      await expect(startServer(cfg)).rejects.toThrow(/AGE_RECIPIENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to start when the schema check fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-bad-'));
    try {
      const sqlDir = join(root, 'sql');
      mkdirSync(sqlDir);
      writeFileSync(
        join(sqlDir, '99_extra.sql'),
        'CREATE TRIGGER not_in_any_migration AFTER INSERT ON user BEGIN SELECT 1; END;',
      );
      const cfg = loadConfig({ ...baseEnv(join(root, 'data'), fakeWebDir(root)), SQL_DIR: sqlDir });
      await expect(startServer(cfg)).rejects.toThrow(/schema check failed.*not_in_any_migration/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a restart applies nothing; an upgrade saves the database to pre-migrate/ first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-twice-'));
    try {
      const identity = await generateX25519Identity();
      const env = baseEnv(join(root, 'data'), fakeWebDir(root), {
        ALLOW_UNENCRYPTED_BACKUPS: undefined,
        AGE_RECIPIENT: await identityToRecipient(identity),
      });
      const first = await startServer(loadConfig(env));
      expect(first.migrationsApplied.length).toBeGreaterThan(20);
      await first.close();
      const second = await startServer(loadConfig(env));
      expect(second.migrationsApplied).toEqual([]);
      expect(second.preMigrate).toBeNull();
      await second.close();

      // A new release: one more migration.
      const migs = join(root, 'migrations');
      cpSync(MIGRATIONS_DIR, migs, { recursive: true });
      writeFileSync(join(migs, '9999_test_upgrade.sql'), 'CREATE TABLE zz_upgrade (id INTEGER);');
      const third = await startServer(loadConfig({ ...env, MIGRATIONS_DIR: migs }));
      try {
        expect(third.migrationsApplied).toEqual(['9999_test_upgrade.sql']);
        const last = migrationNames(MIGRATIONS_DIR)
          .at(-1)
          ?.replace(/\.sql$/, '');
        expect(third.preMigrate).toMatch(
          new RegExp(`^pre-migrate/.+-${last}\\.sqlite\\.gz\\.age$`),
        );
        const file = readFileSync(join(root, 'data/backups', third.preMigrate ?? ''));
        const d = new Decrypter();
        d.addIdentity(identity);
        const before = join(root, 'before.sqlite');
        writeFileSync(before, gunzipSync(await d.decrypt(new Uint8Array(file))));
        const copy = new Database(before, { readonly: true });
        const names = (
          copy.prepare(`SELECT name FROM ${D1_MIGRATIONS_TABLE}`).all() as { name: string }[]
        ).map((r) => r.name);
        copy.close();
        expect(names).not.toContain('9999_test_upgrade.sql');
        expect(names).toHaveLength(migrationNames(MIGRATIONS_DIR).length);
      } finally {
        await third.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a failed pre-migration backup stops the start and migrates nothing', async () => {
    if (process.getuid?.() === 0) return; // root ignores the permission this relies on
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-premig-'));
    try {
      const env = baseEnv(join(root, 'data'), fakeWebDir(root));
      await (await startServer(loadConfig(env))).close();
      const migs = join(root, 'migrations');
      cpSync(MIGRATIONS_DIR, migs, { recursive: true });
      writeFileSync(join(migs, '9999_test_upgrade.sql'), 'CREATE TABLE zz_upgrade (id INTEGER);');
      chmodSync(join(root, 'data/tmp'), 0o500);
      await expect(startServer(loadConfig({ ...env, MIGRATIONS_DIR: migs }))).rejects.toThrow(
        /backup before migrating failed, so nothing was migrated/,
      );
      chmodSync(join(root, 'data/tmp'), 0o700);
      const db = new Database(join(root, 'data/maktab.sqlite'), { readonly: true });
      const names = (
        db.prepare(`SELECT name FROM ${D1_MIGRATIONS_TABLE}`).all() as { name: string }[]
      ).map((r) => r.name);
      const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'zz_upgrade'").all();
      db.close();
      expect(names).not.toContain('9999_test_upgrade.sql');
      expect(table).toEqual([]);
    } finally {
      chmodSync(join(root, 'data/tmp'), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SIGTERM with a request in flight', () => {
  it('finishes the request, then exits 0 and closes the database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-sigterm-'));
    const script = join(root, 'run.mts');
    writeFileSync(
      script,
      `import { main } from ${JSON.stringify(here('../src/node.ts'))};\nawait main();\n`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: here('..'),
      env: { ...process.env, ...baseEnv(join(root, 'data'), fakeWebDir(root)) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    try {
      const port = await vi.waitFor(
        () => {
          const m = /listening on [^:]+:(\d+)/.exec(out);
          if (!m) throw new Error('not yet');
          return Number(m[1]);
        },
        { timeout: 20_000, interval: 100 },
      );
      // A report whose body arrives in two parts, with SIGTERM in between.
      const answered = new Promise<number>((done, fail) => {
        const req = request(
          `http://127.0.0.1:${port}/api/backup/runs`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${REPORT_TOKEN}`,
              'content-type': 'application/json',
              origin: 'http://localhost:5173',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => done(res.statusCode ?? 0));
          },
        );
        req.on('error', fail);
        req.write('{"kind":"nightly",');
        setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => req.end('"status":"ok"}'), 300);
        }, 200);
      });
      expect(await answered).toBe(201);
      expect(await exited).toBe(0);
      expect(out).toMatch(/SIGTERM: shutting down/);
      // Closed cleanly: the WAL was checkpointed away and the run is in the main file.
      expect(readdirSync(join(root, 'data')).filter((f) => f.endsWith('-wal'))).toEqual([]);
      const db = new Database(join(root, 'data/maktab.sqlite'), { readonly: true });
      const n = db.prepare('SELECT count(*) AS n FROM backup_run').get() as { n: number };
      db.close();
      expect(n.n).toBe(1);
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('error logging on the Node path', () => {
  it('logs one line with message and code, never a query’s parameters', async () => {
    const cause = Object.assign(new Error('disk I/O error at guardian.phone'), {
      code: 'SQLITE_IOERR',
    });
    const drizzle = new Error(
      'Failed query: insert into guardian (name, phone) values (?, ?)\nparams: Ayesha Khan,03001234567',
      { cause },
    );
    const line = safeErrorLine(drizzle);
    expect(line).toBe('Error: query failed: disk I/O error at guardian.phone (SQLITE_IOERR)');
    expect(safeErrorLine(new Error('a\nparams: secret'))).toBe('Error: a');

    const { app } = createApp({ getDb: () => ({}) as never, logError: logErrorLine });
    app.get('/boom', () => {
      throw drizzle;
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await app.request('/boom');
      expect(r.status).toBe(500);
      const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('internal error: Error: query failed: disk I/O error');
      expect(logged).not.toMatch(/Ayesha|03001234567|params/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('run_worker_first', () => {
  it('matches apps/api/wrangler.toml exactly', () => {
    const toml = readFileSync(here('../wrangler.toml'), 'utf8');
    const line = /^run_worker_first\s*=\s*\[(.*)\]\s*$/m.exec(toml)?.[1] ?? '';
    const list = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(list).toEqual([...RUN_WORKER_FIRST]);
  });

  it('uses the Workers pattern semantics', () => {
    expect(runsWorkerFirst('/api/identity')).toBe(true);
    expect(runsWorkerFirst('/api/')).toBe(true);
    expect(runsWorkerFirst('/api')).toBe(false);
    expect(runsWorkerFirst('/apix')).toBe(false);
    expect(runsWorkerFirst('/p')).toBe(true);
    expect(runsWorkerFirst('/p/x')).toBe(true);
    expect(runsWorkerFirst('/people')).toBe(false);
  });
});

describe('_headers parsing', () => {
  it('handles splats, placeholders, joins, detaches, comments and skips host rules', () => {
    const rules = parseHeadersFile(
      [
        '# comment',
        '/*',
        '  X-A: one',
        '  X-Gone: yes',
        '/assets/*',
        '  X-A: two',
        '  ! X-Gone',
        '/users/:id/card',
        '  X-Card: 1',
        'https://other.example/*',
        '  X-Host: no',
        '/bad',
        '  not a header line',
        '  X Bad: v',
      ].join('\n'),
    );
    const at = (p: string) => Object.fromEntries(headersFor(rules, p));
    expect(at('/')).toEqual({ 'x-a': 'one', 'x-gone': 'yes' });
    expect(at('/assets/x.js')).toEqual({ 'x-a': 'one, two' });
    expect(at('/users/42/card')).toMatchObject({ 'x-card': '1' });
    expect(at('/users/4/2/card')['x-card']).toBeUndefined();
    expect(rules.some((r) => r.set.some(([k]) => k === 'X-Host'))).toBe(false);
    expect(rules.find((r) => r.pattern === '/bad')?.set).toEqual([]);
  });
});
