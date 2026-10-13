# Pre-pilot checklist: everything true before real data

Tick every box before the pilot school enters a real student or a real rupee (PLAN §15, M7). Each
item says **what**, **how to verify**, and **who** (Owner = the school owner; Maintainer = whoever
runs the Cloudflare and GitHub accounts). Record the date next to each tick.

**M7b (UI/UX polish & branding, PLAN §15) must be finished — reviewed, verified and deployed —
before this gate is worked through.** The pilot school's staff learn the app once; they must learn
the M7b screens, not the M7a ones. Do not start ticking below until M7b is recorded as done in
docs/PLAN.md.

Production: https://maktab.conceptlix.com · repo `faysalmehmood/maktab` · runbooks:
docs/deploy.md, docs/backup.md, docs/restore.md, docs/android-checks.md.

## 1. Backups

- [ ] **Cloudflare API token stored as GitHub secret `CLOUDFLARE_API_TOKEN`.**
  Custom token: Account · D1 · Edit, Account · Workers R2 Storage · Edit, Account · Workers Scripts ·
  Read (docs/backup.md §2). The value never passes through chat or an agent:
  `pbpaste | gh secret set CLOUDFLARE_API_TOKEN -R faysalmehmood/maktab`.
  Verify: `gh secret list -R faysalmehmood/maktab` shows it. — Maintainer
- [ ] **GitHub variable `BACKUP_ENABLED=true`.** Without it the workflow does nothing.
  Verify: `gh variable list -R faysalmehmood/maktab`. — Maintainer
- [ ] **First nightly run green.** Actions → nightly-backup → Run workflow (or wait for 02:30 PKT).
  Verify: the run is green; Settings → Backup shows "Last nightly backup" OK (or Partial without B2)
  and the newest files in the bucket; no open issue labelled `backup-failed`. — Maintainer, Owner
  looks at Settings → Backup
- [ ] **Backblaze B2 secrets `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT`.** Second provider;
  without them every run is "partial". Verify: next run reports OK with two copies. — Maintainer
- [ ] **R2 lifecycle rule** on bucket `maktab-backups`: prefix `daily/`, delete after **95 days**; no
  rule on `monthly/` (docs/backup.md §4). Verify: R2 → maktab-backups → Settings → Object lifecycle
  rules lists it. — Maintainer
- [ ] **Restore drill run and recorded.** Protected environment `backup-drill` with `AGE_SECRET_KEY`,
  then Actions → restore-drill → Run workflow (or docs/restore.md §B by hand). Verify: run green
  (tables, triggers, views match; ledger check empty); Settings → Backup → Restore drill → **Record
  drill** shows "Last drill: <date>". — Maintainer runs, Owner records
- [ ] **Key escrow.** The age private key (`maktab-backup-key.txt`) and the production
  `PARENT_LINK_SECRET` are with the two trustees (password manager + USB stick in a safe), plus one
  escrow copy. Verify: each trustee confirms in writing they can open their copy; then delete the key
  from any laptop where it is not needed. — Owner (trustees), Maintainer hands over
- [ ] **Owner has done one "Download everything"** and opened the ZIP. Verify: `tables/student.csv`
  opens in a spreadsheet. — Owner

## 2. Security

- [ ] **Cloudflare WAF rate-limiting rules** (docs/deploy.md "Rate limiting"):
  `/p*` and `/api/p*` 60 requests/min per IP; `/api/auth/*` 20/min per IP; POST `/api/*` 300/min per
  IP. Verify: the three rules are active in the zone's Security → WAF → Rate limiting rules; a quick
  burst of 70 requests to `/api/p` from one IP gets blocked. — Maintainer
- [ ] **Turnstile** (docs/deploy.md "Turnstile"): widget created for `maktab.conceptlix.com`; site key
  in `TURNSTILE_SITE_KEY` under `[env.production.vars]` in `apps/api/wrangler.toml`; secret set with
  `npx wrangler secret put TURNSTILE_SECRET --env production`; Worker redeployed. Verify:
  `npx wrangler secret list --env production` lists `TURNSTILE_SECRET`; the parent-page check shows
  the Turnstile widget and still accepts a correct birth year. — Maintainer
- [ ] **Secrets complete.** `SESSION_SECRET`, `PARENT_LINK_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `BACKUP_REPORT_TOKEN`, `TURNSTILE_SECRET`. Verify: `wrangler secret list`.
  — Maintainer
- [ ] **Google OAuth consent screen published** (not "Testing"), scopes openid/email/profile only.
  Verify: Google Cloud console → OAuth consent screen shows "In production". — Maintainer
- [ ] **No demo data in production.** Verify: Students list has no seed names. — Owner

## 3. People

- [ ] **Owner signed in** with the owner email (the production `OWNER_EMAIL`). Verify: Settings →
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
- [ ] **Production deploy runbook** (docs/deploy.md) walked through once by the person who will deploy
  during the pilot: backup first, migrate, `db:verify`, deploy, after-checks; never in school hours.
  — Maintainer
- [ ] **`npm run db:verify -- --remote --env production`** is green on the deployed version (trigger
  and view counts match). Verify: output shows "expected" counts equal. — Maintainer
- [ ] **`SELECT * FROM ledger_consistency`** is empty and the dashboard shows no alarm banner. —
  Maintainer
- [ ] **Paper fallback agreed**: receipt book and paper register for a day when the app is down. — Owner
