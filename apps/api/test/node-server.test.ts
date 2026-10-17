import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1_MIGRATIONS_TABLE, MIGRATIONS_DIR, migrationNames } from '@maktab/db/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  chooseClientIp,
  loadConfig,
  RUN_WORKER_FIRST,
  type RunningServer,
  runsWorkerFirst,
  startServer,
} from '../src/node';
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
  writeFileSync(join(web, 'manifest.webmanifest'), '{}');
  writeFileSync(join(web, 'icons', 'icon.svg'), '<svg/>');
  writeFileSync(join(web, '.secret'), 'never served');
  copyFileSync(HEADERS_SRC, join(web, '_headers'));
  return web;
}

/**
 * node:http, not fetch: undici always sends its own `Sec-Fetch-Mode: cors`, and the SPA fallback
 * depends on what a browser sends there.
 */
function raw(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  return new Promise((done, fail) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
        done({
          status: res.statusCode ?? 0,
          headers: h,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', fail);
    req.end();
  });
}

const baseEnv = (dataDir: string, webDir: string) => ({
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
});

describe('self-hosted Node server', () => {
  let root: string;
  let srv: RunningServer;
  let base: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'maktab-node-'));
    const web = fakeWebDir(root);
    srv = await startServer(loadConfig(baseEnv(join(root, 'data'), web)));
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /healthz: 200 with version and db ok', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', version: 'test-1', db: 'ok' });
  });

  it('serves index.html with every _headers rule applied (parsed, not copied)', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await r.text()).toContain('<div id="root">');
    const expected = headersFor(parseHeadersFile(readFileSync(HEADERS_SRC, 'utf8')), '/');
    expect([...expected.keys()].length).toBeGreaterThanOrEqual(5);
    for (const [k, v] of expected) expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  it('hashed assets are immutable; If-None-Match answers 304', async () => {
    const r = await fetch(`${base}/assets/index-AbCd1234.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = r.headers.get('etag') ?? '';
    const again = await fetch(`${base}/assets/index-AbCd1234.js`, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
  });

  it('SPA fallback for a navigation; JSON 404 from the app for anything else', async () => {
    const nav = await raw(`${base}/students/abc`, { 'sec-fetch-mode': 'navigate' });
    expect(nav.status).toBe(200);
    expect(nav.text).toContain('<div id="root">');
    expect(nav.headers.get('x-frame-options')).toBe('DENY');
    const curlish = await raw(`${base}/settings`, { accept: 'text/html' });
    expect(curlish.status).toBe(200);
    const script = await raw(`${base}/assets/missing.js`, { 'sec-fetch-mode': 'no-cors' });
    expect(script.status).toBe(404);
    expect((JSON.parse(script.text) as { error: { code: string } }).error.code).toBe('not_found');
    const noAccept = await raw(`${base}/students`);
    expect(noAccept.status).toBe(404);
  });

  it('never serves _headers, dot-files, directories or anything outside the web root', async () => {
    for (const p of [
      '/_headers',
      '/.secret',
      '/icons/',
      '/%2e%2e/data/maktab.sqlite',
      '/..%2fdata%2fmaktab.sqlite',
      '/assets/..%2f..%2fdata/maktab.sqlite',
    ]) {
      const r = await raw(`${base}${p}`, { 'sec-fetch-mode': 'no-cors' });
      expect(r.status, p).toBe(404);
      expect(r.text).not.toContain('SQLite');
    }
  });

  it('/index.html redirects to / (auto-trailing-slash)', async () => {
    const r = await fetch(`${base}/index.html`, { redirect: 'manual' });
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe('/');
  });

  it('GET /api/identity answers from the app (200)', async () => {
    const r = await fetch(`${base}/api/identity`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ school: null });
  });

  it('/__scheduled is not exposed (404), even for a navigation', async () => {
    for (const h of [{}, { 'sec-fetch-mode': 'navigate' }] as Record<string, string>[]) {
      const r = await raw(`${base}/__scheduled`, h);
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
      expect(r.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
      expect(await r.text()).toContain('<div id="root">');
    }
    // /api without a slash is not under /api/* (the Workers pattern): the SPA answers a navigation.
    const api = await raw(`${base}/api`, { 'sec-fetch-mode': 'navigate' });
    expect(api.headers.get('content-type')).toMatch(/^text\/html/);
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

  it('applied every migration with wrangler’s d1_migrations rows, in order', () => {
    const rows = srv.sqlite
      .prepare(`SELECT id, name, applied_at FROM ${D1_MIGRATIONS_TABLE} ORDER BY id`)
      .all() as { id: number; name: string; applied_at: string }[];
    expect(rows.map((r) => r.name)).toEqual(migrationNames(MIGRATIONS_DIR));
    expect(rows[0]?.name).toBe('0000_init.sql');
    expect(rows.every((r) => r.applied_at)).toBe(true);
    expect(srv.migrationsApplied).toHaveLength(rows.length);
    expect(srv.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(srv.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('per-IP rate limit keys on CF-Connecting-IP (then X-Forwarded-For), not the socket', async () => {
    const hit = (h: Record<string, string>) =>
      fetch(`${base}/api/auth/google/start`, { headers: h, redirect: 'manual' });
    for (let i = 0; i < 20; i++)
      expect((await hit({ 'cf-connecting-ip': '203.0.113.7' })).status).not.toBe(429);
    expect((await hit({ 'cf-connecting-ip': '203.0.113.7' })).status).toBe(429);
    // An X-Forwarded-For cannot dodge the CF-Connecting-IP the tunnel set.
    expect(
      (await hit({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })).status,
    ).toBe(429);
    expect((await hit({ 'cf-connecting-ip': '203.0.113.8' })).status).not.toBe(429);
    expect((await hit({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' })).status).not.toBe(429);
  });
});

describe('client IP choice', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('trusts the tunnel headers only when told to', () => {
    expect(chooseClientIp(h({ 'cf-connecting-ip': '203.0.113.1' }), '172.18.0.5', true)).toBe(
      '203.0.113.1',
    );
    expect(
      chooseClientIp(h({ 'x-forwarded-for': '198.51.100.2, 172.18.0.1' }), '172.18.0.5', true),
    ).toBe('198.51.100.2');
    expect(
      chooseClientIp(h({ 'cf-connecting-ip': '203.0.113.1' }), '::ffff:172.18.0.5', false),
    ).toBe('172.18.0.5');
    // Garbage is never an IP.
    expect(chooseClientIp(h({ 'cf-connecting-ip': 'evil, 1.2.3.4' }), '172.18.0.5', true)).toBe(
      '172.18.0.5',
    );
  });
});

describe('start-up refusals', () => {
  it('refuses DEMO_MODE, a missing or short SESSION_SECRET, a bad APP_ORIGIN', () => {
    const env = baseEnv('/nonexistent', '/nonexistent');
    expect(() => loadConfig({ ...env, DEMO_MODE: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, DEMO_MODE: '0' })).toThrow(/DEMO_MODE/);
    expect(() => loadConfig({ ...env, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...env, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'https://x.example/path' })).toThrow(/origin/);
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'http://x.example' })).toThrow(/https/);
    expect(loadConfig(env).vars.APP_ORIGIN).toBe('http://localhost:5173');
  });

  it('refuses to start when the schema check fails, and leaves the database closed', async () => {
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

  it('a restart applies nothing new (idempotent migrations)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maktab-node-twice-'));
    try {
      const cfg = loadConfig(baseEnv(join(root, 'data'), fakeWebDir(root)));
      const first = await startServer(cfg);
      expect(first.migrationsApplied.length).toBeGreaterThan(20);
      await first.close();
      const second = await startServer(cfg);
      expect(second.migrationsApplied).toEqual([]);
      await second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
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
