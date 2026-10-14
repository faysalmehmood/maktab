#!/usr/bin/env node
/**
 * Retakes the seven README screenshots in docs/media/ from a RUNNING local demo (builds nothing).
 *
 *   node apps/web/scripts/readme-shots.mjs [app-url]     (default http://localhost:5173)
 *     --out docs/media   --port 9351   CHROME=/path/to/chrome overrides the browser
 *
 * The app must be running with demo mode on (POST /api/auth/demo) and the API reachable under
 * <app-url>/api (the Vite dev server proxies it). Headless Chrome over CDP, same approach as
 * sweep-360.mjs: language/theme come from localStorage maktab.lang / maktab.theme, set before load.
 * Which class, family and receipt appear is picked from the data, so a changed demo still works.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const base = (
  args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ??
  'http://localhost:5173'
).replace(/\/$/, '');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = resolve(root, opt('--out', 'docs/media'));
const port = Number(opt('--port', '9351'));

// ---- API (Node side): sign in as the demo principal and find the data to show -------------------
let cookie = '';
async function api(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { Origin: base, 'content-type': 'application/json', cookie, ...init.headers },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}`);
  return res.json();
}
await api('/api/auth/demo', { method: 'POST', body: JSON.stringify({ as: 'principal' }) });
const groups = (await api('/api/groups')).items.filter((g) => g.active_count > 0);
// Prefer the largest class whose register is still open today, so the shot shows attendance
// being taken rather than corrected; fall back to the largest class.
const openToday = new Set(
  ((await api('/api/dashboard/today')).registers?.not_taken ?? []).map((r) => r.grp_id),
);
const bySize = groups.sort((a, b) => b.active_count - a.active_count);
const group = bySize.find((g) => openToday.has(g.id)) ?? bySize[0];
// A family that owes money (so the pages are not empty) and has at least one payment receipt.
const defaulters = (await api('/api/fees/defaulters')).defaulters;
const familyIds = [...new Set(defaulters.map((d) => d.family_id))];
let family, receipt;
for (const id of familyIds) {
  const st = await api(`/api/fees/family/${id}`);
  const r = st.receipts.find((x) => x.kind === 'payment' && !x.reversed_by);
  if (r) {
    family = id;
    receipt = r;
    break;
  }
}
if (!family) throw new Error('no family with dues and a payment receipt in the demo data');
const fam = await api(`/api/families/${family}`);
const link = await api(`/api/guardians/${fam.guardians[0].id}/parent-link`, {
  method: 'POST',
  body: '{}',
});
const parentPath = new URL(link.url, base).pathname + new URL(link.url, base).hash;
console.log(
  `class ${group.programme_name} ${group.name}, family ${fam.name}, receipt ${receipt.receipt_no}`,
);

// ---- Chrome over CDP -----------------------------------------------------------------------------
const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const profile = mkdtempSync(join(tmpdir(), 'readme-shots-'));
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
browser.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    const { ok, ko } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) ko(new Error(m.error.message));
    else ok(m.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok, ko) => {
    const id = ++seq;
    pending.set(id, { ok, ko });
    browser.send(JSON.stringify({ id, method, params, sessionId }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const d of ['Page', 'Runtime', 'Network']) await send(`${d}.enable`, {}, sessionId);
  const [cname, ...cval] = cookie.split('; ')[0].split('=');
  await send('Network.setCookie', { name: cname, value: cval.join('='), url: base }, sessionId);
  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.value;
  };
  let initId;
  /** Opens `path` with the viewport, language and theme, and waits until the data has loaded. */
  async function open(path, { vp, lang, theme, ready = 'true' }) {
    await send('Emulation.setDeviceMetricsOverride', vp, sessionId);
    await send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: vp.mobile, maxTouchPoints: 5 },
      sessionId,
    );
    await send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: theme }] },
      sessionId,
    );
    if (initId)
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initId }, sessionId);
    ({ identifier: initId } = await send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `try{localStorage.setItem('maktab.lang','${lang}');localStorage.setItem('maktab.theme','${theme}')}catch{}`,
      },
      sessionId,
    ));
    await send('Page.navigate', { url: base + path }, sessionId);
    await sleep(800);
    for (let i = 0; i < 75; i++) {
      const ok = await evaluate(`(() => {
        if (document.readyState !== 'complete') return false;
        if (document.querySelector('[data-skeleton],[aria-busy=true],[role=progressbar]')) return false;
        if (/^(Loading|لوڈ ہو رہا)/.test((document.querySelector('main')||document.body).innerText.trim())) return false;
        if (location.pathname === '/login') throw new Error('bounced to /login');
        return !!(${ready});
      })()`);
      if (ok) break;
      if (i === 74) throw new Error(`timed out waiting for ${path}`);
      await sleep(200);
    }
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
    await sleep(600);
  }
  const text = (re) => `new RegExp(${JSON.stringify(re)}).test(document.body.innerText)`;
  const shot = async (name) => {
    const { data } = await send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      sessionId,
    );
    writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
    console.log('wrote', name);
  };

  await open('/', {
    vp: DESKTOP,
    lang: 'en',
    theme: 'light',
    ready: text('Collected|collection|Today'),
  });
  await shot('home-desktop.png');

  await open(`/attendance/register/${group.id}`, {
    vp: PHONE,
    lang: 'ur',
    theme: 'light',
    ready: `document.querySelectorAll('main li, main [role=row], main button').length > 5`,
  });
  await shot('attendance-phone-urdu.png');

  await open('/messages', {
    vp: PHONE,
    lang: 'en',
    theme: 'light',
    ready: `document.querySelectorAll('main li, main [role=row]').length > 0`,
  });
  await shot('whatsapp-queue-phone.png');

  // The parent page never saves its language: it follows the guardian, so use its own toggle.
  await open(parentPath, { vp: PHONE, lang: 'ur', theme: 'light', ready: text('Listen|سنیں') });
  if ((await evaluate(`document.documentElement.lang`)) !== 'ur') {
    await evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.innerText.includes('اردو'))?.click()`,
    );
    await sleep(800);
  }
  if ((await evaluate(`document.documentElement.lang`)) !== 'ur')
    throw new Error('parent page is not in Urdu');
  await shot('parent-page-phone.png');

  await open(`/receipts/${receipt.id}`, {
    vp: PHONE,
    lang: 'en',
    theme: 'dark',
    ready: text(receipt.receipt_no),
  });
  await shot('receipt-phone-dark.png');

  await open('/fees/defaulters', {
    vp: PHONE,
    lang: 'en',
    theme: 'light',
    ready: `[...document.querySelectorAll('button')].some((b) => /Remind all/i.test(b.innerText))`,
  });
  await shot('defaulters-phone.png');

  // The "Show me" tour of Take attendance: start it from its guide page, then wait for the card.
  await open('/guide/take-attendance', {
    vp: PHONE,
    lang: 'en',
    theme: 'light',
    ready: `document.querySelector('[data-show-me="take-attendance"]')`,
  });
  await evaluate(`document.querySelector('[data-show-me="take-attendance"]').click()`);
  for (let i = 0; i < 50; i++) {
    if (
      await evaluate(
        `!!document.querySelector('[data-tour-card]') && location.pathname.startsWith('/attendance')`,
      )
    )
      break;
    if (i === 49) throw new Error('the tour card never appeared on /attendance');
    await sleep(200);
  }
  await sleep(1000);
  await shot('guide-tour-phone.png');
} finally {
  proc.kill('SIGKILL');
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  browser.close();
}
