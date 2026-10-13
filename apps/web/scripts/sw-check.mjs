#!/usr/bin/env node
/**
 * Service-worker navigation checks (M7a). Run after `npm run build`:
 *
 *   node apps/web/scripts/sw-check.mjs [distDir]             static: the built sw.js
 *   node apps/web/scripts/sw-check.mjs --cdp <origin>         live: an installed app in Chrome
 *
 * Static: reads `navigateFallbackDenylist` out of the generated sw.js and checks that `/p`, `/p/…`
 * and `/api/…` are never answered from the precached index.html (the parent page must come from the
 * Worker with its own noindex / no-referrer / CSP headers), while the app's own routes (and look-
 * alikes such as `/payments`, `/people`) still are.
 *
 * --cdp: opens <origin>/ in headless Chrome (throwaway profile), waits until the service worker
 * controls the page (the app is "installed"), then navigates to /students and to /p and reads
 * `fromServiceWorker` on each document response: /students must come from the service worker, /p
 * must not. Exit 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const problems = [];

if (args[0] !== '--cdp') {
  const dist = args[0] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const m = /denylist:\[([^\]]*)\]/.exec(sw);
  if (!m) {
    console.error('sw-check: no navigateFallbackDenylist in sw.js');
    process.exit(1);
  }
  // The array literal holds only regex literals: evaluate it in isolation.
  const deny = new Function(`return [${m[1]}]`)();
  const denied = (p) => deny.some((re) => re.test(p));
  for (const p of ['/p', '/p/', '/p/anything', '/api/me', '/api/p'])
    if (!denied(p)) problems.push(`${p} would be served from the precache`);
  for (const p of ['/', '/students', '/payments', '/people', '/parents', '/settings/messages'])
    if (denied(p)) problems.push(`${p} would not get the offline app shell`);
  if (problems.length) {
    for (const x of problems) console.error(`sw-check: ${x}`);
    process.exit(1);
  }
  console.log(`sw-check: denylist ${m[1]} ok`);
  process.exit(0);
}

const origin = (args[1] ?? '').replace(/\/$/, '');
if (!origin) {
  console.error('usage: sw-check.mjs --cdp <origin>');
  process.exit(2);
}
const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const profile = mkdtempSync(join(tmpdir(), 'sw-check-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const exited = new Promise((ok) => proc.once('exit', ok));
const cleanup = async () => {
  proc.kill('SIGKILL');
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};
setTimeout(async () => {
  console.error('sw-check: timed out');
  await cleanup();
  process.exit(2);
}, 60_000).unref();

const wsUrl = await new Promise((ok) => {
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) ok(m[1]);
  });
});
const browser = new WebSocket(wsUrl);
await new Promise((ok) => browser.addEventListener('open', ok, { once: true }));
let seq = 0;
const pending = new Map();
const responses = [];
browser.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    const { ok, ko } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) ko(new Error(m.error.message));
    else ok(m.result);
  } else if (m.method === 'Network.responseReceived' && m.params.type === 'Document')
    responses.push(m.params.response);
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok, ko) => {
    const id = ++seq;
    pending.set(id, { ok, ko });
    browser.send(JSON.stringify({ id, method, params, sessionId }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  const evaluate = async (expression) =>
    (
      await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
    ).result.value;
  const go = async (path) => {
    responses.length = 0;
    await send('Page.navigate', { url: `${origin}${path}` }, sessionId);
    for (let i = 0; i < 50 && !responses.length; i++) await sleep(100);
    for (let i = 0; i < 50; i++) {
      if (await evaluate(`document.readyState === 'complete'`)) break;
      await sleep(100);
    }
    return responses[0];
  };
  await go('/');
  // Installed = the service worker is active and controls this page (a reload hands control over).
  for (let i = 0; i < 50; i++) {
    if (await evaluate('navigator.serviceWorker?.ready.then(() => true)')) break;
    await sleep(200);
  }
  await go('/');
  if (!(await evaluate('!!navigator.serviceWorker?.controller')))
    problems.push('the service worker never took control of the page');
  const app = await go('/students');
  if (!app?.fromServiceWorker) problems.push('/students was not served by the service worker');
  const parent = await go('/p');
  if (!parent) problems.push('/p: no document response');
  else if (parent.fromServiceWorker) problems.push('/p was served by the service worker');
  console.log(
    `sw-check --cdp: /students fromServiceWorker=${!!app?.fromServiceWorker}; /p fromServiceWorker=${!!parent?.fromServiceWorker} status=${parent?.status} robots=${parent?.headers?.['x-robots-tag'] ?? parent?.headers?.['X-Robots-Tag'] ?? '-'}`,
  );
} catch (e) {
  problems.push(String(e));
}
await cleanup();
for (const x of problems) console.error(`sw-check: ${x}`);
process.exit(problems.length ? 1 : 0);
