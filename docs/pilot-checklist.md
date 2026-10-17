# Pre-pilot checklist: everything true before real data

Tick every box before the pilot school enters a real student or a real rupee (PLAN §15, M7). Each
item says **what**, **how to verify**, and **who** (Owner = the school owner; Maintainer = whoever
runs the Cloudflare and GitHub accounts). Record the date next to each tick.

**M7b (UI/UX polish & branding, PLAN §15) must be finished — reviewed, verified and deployed —
before this gate is worked through.** The pilot school's staff learn the app once; they must learn
the M7b screens, not the M7a ones. Do not start ticking below until M7b is recorded as done in
docs/PLAN.md.

M7b prerequisite: met. PLAN §15 records M7b closed on 2026-10-13 (parts 1 and 2 merged and live).

Pilot (Global Science Academy): https://maktab-gsap.conceptlix.com · Worker env `gsap` · D1
`maktab-gsap` · R2 `maktab-gsap-files` · backups bucket `maktab-backups` · owner
shahid.ics.pu@gmail.com · repo `faysalmehmood/maktab` · runbooks: docs/deploy.md, docs/backup.md,
docs/restore.md, docs/android-checks.md. The public demo (https://maktab.conceptlix.com, env `demo`,
fictional data, no backups) is a separate instance and is out of scope for this gate.

Status notes below come from docs/deploy-log.md. They are not ticks: a box is ticked only once its
**Verify** step has been done and the date written next to it.

## 1. Backups

- [ ] **Cloudflare API token stored as GitHub secret `CLOUDFLARE_API_TOKEN`.**
  Custom token: Account · D1 · Edit, Account · Workers R2 Storage · Edit, Account · Workers Scripts ·
  Read (docs/backup.md §2). The value never passes through chat or an agent:
  `pbpaste | gh secret set CLOUDFLARE_API_TOKEN -R faysalmehmood/maktab`.
  Verify: `gh secret list -R faysalmehmood/maktab` shows it. — Maintainer
- [ ] **GitHub variable `BACKUP_ENABLED=true`.** Without it the workflow does nothing.
  Status: `BACKUP_ENABLED` is currently `false` (deploy-log 2026-10-13); the workflows already export
  `--env gsap`, and the variables `D1_DATABASE_NAME=maktab-gsap` and
  `APP_URL=https://maktab-gsap.conceptlix.com` are set. Flip it to `true` only after the token above.
  Verify: `gh variable list -R faysalmehmood/maktab`. — Maintainer
- [ ] **First nightly run green.** Actions → nightly-backup → Run workflow (or wait for 02:30 PKT).
  Verify: the run is green; Settings → Backup shows "Last nightly backup" OK (or Partial without B2)
  and the newest files in the bucket; no open issue labelled `backup-failed`. — Maintainer, Owner
  looks at Settings → Backup
- [ ] **Backblaze B2 secrets `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT`.** Second provider;
  without them every run is "partial". Verify: next run reports OK with two copies. — Maintainer
- [x] **R2 lifecycle rule** on bucket `maktab-backups`: prefix `daily/`, delete after **95 days**; no
  rule on `monthly/` (docs/backup.md §4). Verify: R2 → maktab-backups → Settings → Object lifecycle
  rules lists it. — Maintainer. **Done 2026-10-17**: rule `daily-95d` added with
  `wrangler r2 bucket lifecycle add`; `wrangler r2 bucket lifecycle list maktab-backups` shows it
  (plus the default multipart-abort rule).
- [ ] **Restore drill run and recorded.** Protected environment `backup-drill` with `AGE_SECRET_KEY`,
  then Actions → restore-drill → Run workflow (or docs/restore.md §B by hand). Verify: run green
  (tables, triggers, views match; ledger check empty); Settings → Backup → Restore drill → **Record
  drill** shows "Last drill: <date>". — Maintainer runs, Owner records
- [ ] **Key escrow.** The age private key (`maktab-backup-key.txt`) and the gsap
  `PARENT_LINK_SECRET` are with the two trustees (password manager + USB stick in a safe), plus one
  escrow copy. Verify: each trustee confirms in writing they can open their copy; then delete the key
  from any laptop where it is not needed. — Owner (trustees), Maintainer hands over
- [ ] **Owner has done one "Download everything"** and opened the ZIP. Verify: `tables/student.csv`
  opens in a spreadsheet. — Owner

## 2. Security

- [x] **Cloudflare WAF rate-limiting rules** (docs/deploy.md "Rate limiting") with the host
  expression `maktab-gsap.conceptlix.com` (the demo keeps its own rules for `maktab.conceptlix.com`;
  extend the existing rules rather than replacing them; pending per deploy-log 2026-10-15):
  `/p*`, `/api/p*` (incl. `/api/p/badge`, `/api/p/logo`) and `/api/identity*` (M7b sign-in page
  identity + logo) 60 requests/min per IP; `/api/auth/*` 20/min per IP; POST `/api/*` 300/min per
  IP. Verify: the three rules are active in the zone's Security → WAF → Rate limiting rules; a quick
  burst of 70 requests to `/api/p` from one IP gets blocked. — Maintainer. **Done 2026-10-17** as
  the free plan's single merged rule (docs/deploy.md §7 "maktab public surfaces"): both hosts,
  `/p*`, `/api/p*`, `/api/identity*`, `/api/auth*`, 10 requests / 10 s per IP, Block 10 s. Verified
  on the demo host: 16 requests to `/api/identity` gave 10 × 200 then 6 × 429; `/api/payroll` never
  429. Rule 3 (POST `/api/*` 300/min) waits for a Pro zone.
- [ ] **Turnstile** (docs/deploy.md "Turnstile"): widget hostnames include `maktab-gsap.conceptlix.com`
  (the demo's hostname stays on its own widget or entry); site key in `TURNSTILE_SITE_KEY` under
  `[env.gsap.vars]` in `apps/api/wrangler.toml`; secret set with
  `npx wrangler secret put TURNSTILE_SECRET --env gsap`; Worker redeployed. Verify:
  `npx wrangler secret list --env gsap` lists `TURNSTILE_SECRET`; the parent-page check shows
  the Turnstile widget and still accepts a correct birth year. — Maintainer
- [ ] **Secrets complete.** `SESSION_SECRET`, `PARENT_LINK_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `BACKUP_REPORT_TOKEN`, `TURNSTILE_SECRET`. Verify:
  `npx wrangler secret list --env gsap`. Status (deploy-log): `SESSION_SECRET`, `PARENT_LINK_SECRET`
  and `BACKUP_REPORT_TOKEN` set on gsap 2026-10-13 (`BACKUP_REPORT_TOKEN` regenerated 2026-10-14
  and rotated again 2026-10-15 after the GitHub account incident, together with the GitHub secret,
  one value); `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are NOT set on gsap as of 2026-10-17
  (`wrangler secret list --env gsap` shows three secrets; sign-in answers 500), see the redirect item
  below; `TURNSTILE_SECRET` is covered by the Turnstile item. — Maintainer
- [ ] **Google OAuth redirect URI for gsap.** `https://maktab-gsap.conceptlix.com/api/auth/google/callback`
  added to the OAuth client, then `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set with
  `npx wrangler secret put <NAME> --env gsap`. Verify: `/api/auth/google/start` redirects to Google
  instead of answering 500 `misconfigured`. Status: listed as pending in deploy-log 2026-10-15;
  record the date here once done. — Maintainer
- [ ] **Google OAuth consent screen published** (not "Testing"), scopes openid/email/profile only.
  Verify: Google Cloud console → OAuth consent screen shows "In production". — Maintainer
- [ ] **No demo data on the pilot instance.** The demo lives on a separate instance; the pilot
  started empty on 2026-10-13 (only the migration-seeded expense categories and message templates).
  Verify: Students list has no seed names. — Owner

## 3. People

- [ ] **Owner signed in** with the owner email (the gsap `OWNER_EMAIL`, shahid.ics.pu@gmail.com; his first Google sign-in claims the empty
  installation and starts the setup wizard). Verify: Settings →
  Account shows role Owner. — Owner
- [ ] **At least one Admin (or second Owner) invited and signed in.** An owner on the payroll needs a
  second owner/admin to approve their own payslip, and a second person can reach Settings if the owner
  is away. Verify: Settings → Staff shows them Active. — Owner
- [ ] **Teachers invited with their groups**; each signed in once on their own phone. Verify: Staff
  list Active; each teacher sees only their groups under Attendance. — Owner

## 4. School data

- [ ] **School profile**: name (en + ur), address, phone, logo, default language. — Owner
- [ ] **Receipt prefix** set (Settings → School). It locks after the first receipt. — Owner
- [ ] **Session** current, **classes/groups** made, class teachers set. — Owner
- [ ] **Fee heads and rates** for every class (Settings → Fees), late-fine rule decided, sibling rule
  decided, accounts (one cash drawer per collector, bank, wallets) with opening balances. Verify:
  Fees → Monthly billing → **Preview** for the first month lists no group with zero fees. — Owner
- [ ] **Message templates reviewed in English and Urdu** (Settings → Messages): wording, school name,
  `{link}` on the last line, reminder cooldown days, parent-page check (default: child's birth year).
  Verify: Owner reads every template aloud in both languages. — Owner
- [ ] **Opening balances** entered for students who owed or held advance before Maktab. — Owner/Office

## 5. Devices (Android)

Run every check in docs/android-checks.md on at least one staff phone and one guardian-type low-end
phone; fill its results table. — Maintainer with Owner

- [ ] `/diag` report copied and saved for each phone.
- [ ] **wa.me with Urdu text** (send queue → Open WhatsApp) opens WhatsApp with the Urdu text intact
  and the link on its own last line.
- [ ] **Share / PDF**: receipt Share opens the share sheet; Print → Save as PDF → share to WhatsApp works.
- [ ] **58 mm thermal print is one page** (and A5 is one page in en and ur).
- [ ] **Offline attendance survives swipe-away**: airplane mode → save register → swipe the app away →
  reopen offline (still queued) → reconnect → synced, exactly once.
- [ ] **Install prompt**: app installs to the home screen and opens standalone.
- [ ] **Urdu voice** for the parent page Listen button is present (or the fallback is acceptable).

## 6. Operations

- [ ] **maktab@conceptlix.com mailbox is monitored.** It is the contact address; GitHub
  `backup-failed` issues and alarm mails go there. Verify: send a test mail; confirm the GitHub
  account watching the repo forwards to it. — Maintainer
- [ ] **Pilot deploy runbook** (docs/deploy.md) walked through once by the person who will deploy
  during the pilot: backup first, migrate, `db:verify`, deploy, after-checks; never in school hours.
  — Maintainer
- [ ] **`npm run db:verify -- --remote --env gsap`** is green on the deployed version (trigger
  and view counts match). Verify: output shows "expected" counts equal. — Maintainer
- [ ] **`SELECT * FROM ledger_consistency`** is empty and the dashboard shows no alarm banner. —
  Maintainer
- [ ] **Paper fallback agreed**: receipt book and paper register for a day when the app is down. — Owner
