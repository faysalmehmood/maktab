#!/usr/bin/env node
/**
 * Page count of a printed page, through Chrome's own print path (CDP `Page.printToPDF` with
 * `preferCSSPageSize`, the same @page rules the print dialog honours). No jsdom: jsdom has no
 * layout, so it cannot tell a blank second page from a clean one.
 *
 *   node apps/web/scripts/print-pages.mjs <url-or-file> [--expect N] [--wait-for <css selector>]
 *
 * Prints `pages=<n> sizes=<w×h pt,…>`; exit 1 when --expect is given and differs. Used for the
 * thermal receipt (M4 fix pass, C2): `/receipts/<id>?paper=thermal` must print exactly 1 page.
 * CHROME=/path/to/chrome overrides the browser (default: Google Chrome on macOS, else
 * `google-chrome` on PATH). The browser runs with a throwaway profile and is killed on exit.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const target = args[0];
if (!target) {
  console.error('usage: print-pages.mjs <url-or-file> [--expect N] [--wait-for selector]');
  process.exit(2);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : undefined;
};
const expect = opt('--expect') ? Number(opt('--expect')) : null;
const waitFor = opt('--wait-for') ?? null;
const url = /^[a-z]+:\/\//.test(target) ? target : pathToFileURL(resolve(target)).href;
const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const profile = mkdtempSync(join(tmpdir(), 'print-pages-'));
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
const fail = async (msg) => {
  console.error(msg);
  await cleanup();
  process.exit(2);
};
setTimeout(() => fail('timed out'), 60_000).unref();

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
const events = [];
browser.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    const { ok, ko } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) ko(new Error(m.error.message));
    else ok(m.result);
  } else if (m.method) events.push(m);
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok, ko) => {
    const id = ++seq;
    pending.set(id, { ok, ko });
    browser.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) =>
    (
      await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
    ).result.value;
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate(
      `document.readyState === 'complete' && ${waitFor ? `!!document.querySelector(${JSON.stringify(waitFor)})` : 'true'}`,
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
  await new Promise((r) => setTimeout(r, 300));
  const { data } = await send('Page.printToPDF', { preferCSSPageSize: true }, sessionId);
  const pdf = Buffer.from(data, 'base64').toString('latin1');
  const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const sizes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map(
    (m) => `${Math.round(Number(m[1]))}×${Math.round(Number(m[2]))}`,
  );
  console.log(`pages=${pages} sizes=${sizes.join(',')}`);
  await cleanup();
  process.exit(expect !== null && pages !== expect ? 1 : 0);
} catch (e) {
  await fail(String(e));
}
