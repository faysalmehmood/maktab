/**
 * Milestone 7 (hardening, code side) over HTTP against `wrangler dev --local`: Turnstile off by
 * default (sign-in goes straight on, the parent gate needs no token), the per-IP limiter's headers
 * and 429, the parent-page link a staff receipt shares, the token-gated school logo for the parent
 * receipt, and `npm run i18n:check` exiting 0.
 *
 *   npm run db:migrate:local && npm run dev        (repo root; .dev.vars without TURNSTILE_*)
 *   npm run smoke:m7 -w @maktab/api
 *
 * Self-contained (random suffix, random client IPs). Leaves the parent-gate setting as it found it;
 * replaces the local school logo with a 1×1 PNG.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  type AdmissionResult,
  type FamilyStatementDto,
  type FeeHeadDto,
  type GroupDto,
  type MessageSettingsDto,
  PARENT_TOKEN_HEADER,
  type ParentPageDto,
  type ProgrammeDto,
  type SchoolResponse,
} from '@maktab/shared';
import { mintDevSession } from './dev-session';
import {
  always,
  BASE,
  completeSetup,
  EMAIL,
  expectOk,
  finish,
  makeApi,
  ORIGIN,
  runId as run,
  step,
} from './smoke-lib';

let ownerCookie = '';
const api = makeApi(() => ownerCookie);
const RS = (n: number) => n * 100;
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
/** A valid 1×1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

async function main() {
  let settings: MessageSettingsDto | null = null;
  let receiptId = '';
  let token = '';

  await step('API reachable', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200, r);
  });

  await step(`owner session for ${EMAIL}; school, session and a group exist`, async () => {
    ownerCookie = (await mintDevSession(EMAIL)).cookie;
    const s = await api<SchoolResponse>('GET', '/api/school');
    if (!s.body.school)
      await api('PUT', '/api/school', { name: 'Smoke Test School', mode: 'both' });
    const y = new Date().getUTCFullYear();
    const sessions = await api<{ items: { is_current: boolean }[] }>('GET', '/api/sessions');
    if (!sessions.body.items.some((x) => x.is_current))
      await api('POST', '/api/sessions', {
        name: `${y}-${y + 1}`,
        start_date: `${y - 1}-04-01`,
        end_date: `${y + 1}-03-31`,
      });
    const after = await api<SchoolResponse>('GET', '/api/school');
    if (!after.body.school?.setup_completed_at) {
      const r = await completeSetup(api);
      expectOk(r.status === 200, r);
    }
  });

  await step('Turnstile off: sign-in goes straight to Google, with RateLimit headers', async () => {
    const r = await fetch(`${BASE}/api/auth/google/start`, {
      redirect: 'manual',
      headers: { 'cf-connecting-ip': ip() },
    });
    const body = await r.text();
    expectOk(!body.includes('cf-turnstile'), 'check page served with Turnstile off');
    // 302 to Google when GOOGLE_CLIENT_ID is set locally, else 500 misconfigured — never the page.
    expectOk(r.status === 302 || r.status === 500, r.status);
    expectOk(r.headers.get('ratelimit-limit') === '20', r.headers.get('ratelimit-limit'));
    return `${r.status}, remaining ${r.headers.get('ratelimit-remaining')}`;
  });

  await step('per-IP limiter: /api/p 60 a minute, then 429 + Retry-After', async () => {
    const from = ip();
    const hit = () =>
      fetch(`${BASE}/api/p`, {
        headers: { 'cf-connecting-ip': from, [PARENT_TOKEN_HEADER]: `x${run}`.padEnd(43, 'x') },
      });
    const first = await hit();
    expectOk(first.headers.get('ratelimit-limit') === '60', first.headers.get('ratelimit-limit'));
    let last = first;
    for (let i = 1; i < 61; i++) last = await hit();
    expectOk(last.status === 429, last.status);
    expectOk(Number(last.headers.get('retry-after')) > 0, last.headers.get('retry-after'));
    const other = await fetch(`${BASE}/api/p`, { headers: { 'cf-connecting-ip': ip() } });
    expectOk(other.status === 404, `another IP: ${other.status}`);
    return 'first 60 answered (404 bad link), 61st 429';
  });

  await step('a family pays: one receipt (bank) for the parent-link checks', async () => {
    const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
    const p = progs.body.items[0];
    expectOk(p, 'no programme');
    const g = await api<GroupDto>('POST', '/api/groups', {
      programme_id: p?.id,
      name: `M7-${run}`,
    });
    expectOk(g.status === 201, g);
    const head = await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', {
      name: `M7 tuition ${run}`,
      kind: 'tuition',
      cadence: 'monthly',
    });
    expectOk(head.status === 201, head);
    const today = new Date().toISOString().slice(0, 10);
    const rate = await api('POST', '/api/fees/rates', {
      fee_head_id: head.body.head.id,
      grp_id: g.body.id,
      amount: RS(1500),
      effective_from: `${today.slice(0, 7)}-01`,
    });
    expectOk(rate.status === 201, rate);
    const phone = `0300${String(Math.floor(1e6 + Math.random() * 8e6))}`;
    const a = await api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: `M7 family ${run}` },
      guardians: [{ name: `M7 father ${run}`, relation: 'father', phone, consent_whatsapp: true }],
      student: { name: `M7 child ${run}`, admission_date: today, dob: '2016-02-02' },
      enrolment: { grp_id: g.body.id },
      fees: { charge: true },
    });
    expectOk(a.status === 201, a);
    let bank = (
      await api<{ accounts: { id: string; kind: string }[] }>('GET', '/api/accounts')
    ).body.accounts.find((x) => x.kind === 'bank')?.id;
    if (!bank)
      bank = (
        await api<{ account: { id: string } }>('POST', '/api/accounts', {
          name: `M7 bank ${run}`,
          kind: 'bank',
        })
      ).body.account.id;
    const st = await api<FamilyStatementDto>('GET', `/api/fees/family/${a.body.family_id}`);
    const r = await api<{ receipt: { id: string; receipt_no: string } }>('POST', '/api/receipts', {
      idempotency_key: `m7-${run}`,
      payer_id: a.body.family_id,
      amount: RS(500),
      method: 'bank',
      account_id: bank,
      expected_due_hash: st.body.dues_hash,
    });
    expectOk(r.status === 201, r);
    receiptId = r.body.receipt.id;
    return r.body.receipt.receipt_no;
  });

  await step('parentReceiptLink: the guardian’s link, the same on a second ask', async () => {
    const s = await api<MessageSettingsDto>('GET', '/api/school/messages');
    settings = s.body;
    if (settings.parent_gate === 'pin')
      await api('PUT', '/api/school/messages', { ...settings, parent_gate: 'birth_year' });
    const one = await api<{ url: string | null }>('POST', `/api/receipts/${receiptId}/parent-link`);
    expectOk(one.status === 200 && one.body.url?.startsWith(`${ORIGIN}/p#`), one);
    const two = await api<{ url: string | null }>('POST', `/api/receipts/${receiptId}/parent-link`);
    expectOk(two.body.url === one.body.url, 'link changed between asks');
    token = one.body.url?.split('#')[1] ?? '';
    const page = await fetch(`${BASE}/api/p`, {
      headers: { [PARENT_TOKEN_HEADER]: token, 'cf-connecting-ip': ip() },
    });
    const dto = (await page.json()) as ParentPageDto;
    expectOk(page.status === 200, page.status);
    expectOk(dto.turnstile_site_key === null, 'Turnstile key offered while off');
    // Turnstile off: the gate answers without a token.
    const gate = await fetch(`${BASE}/api/p/gate`, {
      method: 'POST',
      headers: {
        [PARENT_TOKEN_HEADER]: token,
        'content-type': 'application/json',
        origin: ORIGIN,
        'cf-connecting-ip': ip(),
      },
      body: JSON.stringify({ birth_year: 2016 }),
    });
    expectOk(gate.status === 200, `gate ${gate.status} ${await gate.text()}`);
    return `gate ${dto.gate.kind}`;
  });

  await step('GET /api/p/logo: token-gated PNG, cacheable', async () => {
    const form = new FormData();
    form.append('file', new File([PNG], 'logo.png', { type: 'image/png' }));
    const req = new Request(`${BASE}/api/school/logo`, { method: 'POST', body: form });
    const body = await req.arrayBuffer();
    const up = await fetch(req.url, {
      method: 'POST',
      body,
      headers: {
        cookie: ownerCookie,
        origin: ORIGIN,
        'content-type': req.headers.get('content-type') ?? '',
        'content-length': String(body.byteLength),
      },
    });
    if (up.status === 501) return 'no FILES binding locally: skipped';
    expectOk(up.status === 200, `upload ${up.status} ${await up.text()}`);
    const anon = await fetch(`${BASE}/api/p/logo`, { headers: { 'cf-connecting-ip': ip() } });
    expectOk(anon.status === 404, `no token: ${anon.status}`);
    const logo = await fetch(`${BASE}/api/p/logo?v=smoke`, {
      headers: { [PARENT_TOKEN_HEADER]: token, 'cf-connecting-ip': ip() },
    });
    expectOk(logo.status === 200, logo.status);
    expectOk(logo.headers.get('content-type') === 'image/png', logo.headers.get('content-type'));
    expectOk(
      logo.headers.get('cache-control') === 'private, max-age=604800, immutable',
      logo.headers.get('cache-control'),
    );
    expectOk((await logo.arrayBuffer()).byteLength === PNG.byteLength, 'bytes differ');
  });

  await step('npm run i18n:check exits 0', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const out = execFileSync('npm', ['run', '-s', 'i18n:check'], { cwd: root, encoding: 'utf8' });
    expectOk(/ur complete/.test(out), out);
    return out.trim();
  });

  await always('restore the parent-gate setting', async () => {
    if (settings) {
      const r = await api('PUT', '/api/school/messages', settings);
      expectOk(r.status === 200, r);
    }
  });

  finish();
}

void main();
