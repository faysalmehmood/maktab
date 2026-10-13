#!/usr/bin/env node
/**
 * Phone-width sweep of a RUNNING app (builds nothing). Every route is loaded at 360×780 and
 * 390×844 with touch emulation, in en + ur and light + dark, through headless Chrome over CDP.
 * Per page it reports: document scrollWidth vs the viewport, the smallest interactive target
 * (width × height), and JS console errors / uncaught exceptions. Exit 1 on any horizontal overflow
 * or any target under 44 px (hidden inputs, visually hidden skip links, inline links in running
 * text, and checkboxes/radios wrapped in a ≥ 44 px label are not counted), or a page that
 * bounced to /login.
 *
 *   node apps/web/scripts/sweep-360.mjs <app-url> --cookie name=value [options]
 *     --routes /a,/b@#button-id   comma list; "@selector" clicks that element after load
 *                                 (default: the staff routes below with --var ids filled in)
 *     --var student=ID --var receipt=ID --var family=ID --var group=ID   fill :student etc.
 *     --lang en,ur  --theme light,dark  --viewports 360x780,390x844   (the defaults shown)
 *     --port 9350   Chrome's remote-debugging port
 *
 * Cookie: a dev session, e.g. `npm run -s dev:session -w @maktab/api -- owner@example.com`
 * (same pattern as print-pages.mjs). Run once per role (owner, teacher, accountant) for the home
 * pages. The parent page needs no cookie: pass its link as a route, e.g. `/p#<token>`.
 * CHROME=/path/to/chrome overrides the browser. The browser uses a throwaway profile and is killed on exit.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!base) {
  console.error('usage: sweep-360.mjs <app-url> --cookie name=value [--routes ...] [--var k=v]');
  process.exit(2);
}
const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const opt = (name, dflt) => opts(name)[0] ?? dflt;
const list = (name, dflt) => opt(name, dflt).split(',').filter(Boolean);
const vars = Object.fromEntries(opts('--var').map((v) => v.split(/=(.*)/s).slice(0, 2)));
const DEFAULT_ROUTES = [
  '/',
  '/students',
  '/students/:student',
  '/attendance',
  '/attendance/register/:group',
  '/fees/counter',
  '/fees/counter?family=:family',
  '/fees/family/:family',
  '/receipts/:receipt',
  '/messages',
  '/messages@#msg-focus-start',
  '/groups',
  '/fees/defaulters',
  '/fees/billing',
  '/cash',
  '/fees/concessions',
  '/fees/sponsors',
  '/fees/register',
  '/expenses',
  '/salary',
  '/advances',
  '/reports',
  '/settings',
  '/audit',
];
const routes = list('--routes', DEFAULT_ROUTES.join(','))
  .map((r) => r.replace(/:([a-z]+)/g, (_, k) => vars[k] ?? `:${k}`))
  .filter((r) => {
    const open = /[/=]:[a-z]+/.test(r);
    if (open) console.error(`skipping ${r}: no --var for it`);
    return !open;
  });
const langs = list('--lang', 'en,ur');
const themes = list('--theme', 'light,dark');
const viewports = list('--viewports', '360x780,390x844').map((v) => v.split('x').map(Number));
const port = Number(opt('--port', '9350'));
const cookie = opt('--cookie', null);

const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const profile = mkdtempSync(join(tmpdir(), 'sweep-360-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
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
let onEvent = () => {};
browser.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    const { ok, ko } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) ko(new Error(m.error.message));
    else ok(m.result);
  } else if (m.method) onEvent(m);
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok, ko) => {
    const id = ++seq;
    pending.set(id, { ok, ko });
    browser.send(JSON.stringify({ id, method, params, sessionId }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: overflow, smallest target, who is widest. */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const scrollW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  let wide = '';
  if (scrollW > vw) {
    let best = 0;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right - vw > best + 0.5 && getComputedStyle(el).position !== 'fixed' && !String(el.className).includes('sr-only')) {
        best = r.right - vw;
        wide = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0];
      }
    }
  }
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],[role=link],[tabindex]:not([tabindex="-1"])';
  const seen = new Set();
  let min = null;
  const small = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (el.disabled && el.tagName !== 'A') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden],[aria-hidden=true],[inert]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (el.tagName === 'A' && cs.display === 'inline' && el.parentElement &&
        [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3)) continue;
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) {
      const lab = el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
      if (lab) { const lr = lab.getBoundingClientRect(); if (lr.width >= 44 && lr.height >= 44) continue; }
    }
    const w = Math.round(r.width * 10) / 10, h = Math.round(r.height * 10) / 10;
    const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label').slice(0, 24) + ']' : '');
    if (!min || Math.min(w, h) < Math.min(min.w, min.h)) min = { w, h, name };
    if (w < 43.5 || h < 43.5) small.push({ w, h, name });
  }
  return { vw, scrollW, wide, min, small: small.slice(0, 4), onLogin: location.pathname === '/login' };
})()`;

let failed = 0;
let pages = 0;
let minAll = null;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const d of ['Page', 'Runtime', 'Network']) await send(`${d}.enable`, {}, sessionId);
  if (cookie) {
    const eq = cookie.indexOf('=');
    await send(
      'Network.setCookie',
      { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: base },
      sessionId,
    );
  }
  let errors = [];
  onEvent = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown')
      errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push(
        m.params.args
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 160),
      );
  };
  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    return r.result.value;
  };
  for (const [w, h] of viewports) {
    await send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 2, mobile: true },
      sessionId,
    );
    await send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
      sessionId,
    );
    for (const lang of langs)
      for (const theme of themes) {
        const { identifier } = await send(
          'Page.addScriptToEvaluateOnNewDocument',
          {
            source: `try{localStorage.setItem('maktab.lang','${lang}');localStorage.setItem('maktab.theme','${theme}')}catch{}`,
          },
          sessionId,
        );
        await send(
          'Emulation.setEmulatedMedia',
          { features: [{ name: 'prefers-color-scheme', value: theme }] },
          sessionId,
        );
        for (const route of routes) {
          const [path, click] = route.split('@');
          errors = [];
          await send('Page.navigate', { url: new URL(path, base).href }, sessionId);
          await sleep(400);
          for (let i = 0; i < 40; i++) {
            const idle = await evaluate(
              `document.readyState==='complete' && !document.querySelector('[data-skeleton],[aria-busy=true]')`,
            );
            if (idle) break;
            await sleep(200);
          }
          await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
          if (click) {
            await evaluate(`document.querySelector(${JSON.stringify(click)})?.click()`);
            await sleep(300);
          }
          await sleep(300);
          const m = await evaluate(MEASURE);
          pages++;
          const overflow = m.scrollW > m.vw;
          const smallOnes = m.small.length > 0;
          const bad = overflow || smallOnes || m.onLogin;
          if (m.min && (!minAll || Math.min(m.min.w, m.min.h) < Math.min(minAll.w, minAll.h)))
            minAll = { ...m.min, route };
          if (bad) failed++;
          const mt = m.min ? `${m.min.w}x${m.min.h} ${m.min.name}` : 'none';
          console.log(
            `${bad ? 'FAIL' : 'ok  '} ${route} ${lang} ${theme} ${w}x${h} scroll=${m.scrollW}/${m.vw}` +
              `${overflow ? ` OVERFLOW(${m.wide})` : ''} min=${mt} errors=${errors.length}` +
              `${m.onLogin ? ' REDIRECTED-TO-LOGIN' : ''}` +
              `${smallOnes ? ` small=${m.small.map((s) => `${s.name}:${s.w}x${s.h}`).join(';')}` : ''}` +
              `${errors.length ? ` console=${JSON.stringify(errors.slice(0, 2))}` : ''}`,
          );
        }
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId);
      }
  }
} finally {
  await cleanup();
}
console.log(
  `sweep: ${pages} page loads (${routes.length} routes × ${viewports.length} viewports × ${langs.length} langs × ${themes.length} themes), ` +
    `${failed} failing, min target ${minAll ? `${minAll.w}x${minAll.h} (${minAll.name} on ${minAll.route})` : 'n/a'}`,
);
process.exit(failed ? 1 : 0);
