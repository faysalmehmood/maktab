# School & Academy Management System — Living Plan

Status: **planning, no code yet**. This file is the single source of truth for the plan. Edit it freely; keep the decision log and the open-questions list current.

Last revised: 2026-10-10 (Fable review of the Opus draft; see §13).

---

## 1. Purpose

A free, open-source management system for Pakistani community schools and coaching academies, donated to a pilot school and published for anyone to self-host. Targets: 100–500 students per school (design for 1,000), 5–30 staff on low-end Android phones, patchy internet, Urdu + English, **$0/month to run**, data that survives any single machine dying.

Non-goals for now: multi-school SaaS, online payment gateways, LMS/content delivery, biometric hardware.

## 2. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Build fresh; do not fork | No existing project has batch-style fees + WhatsApp + Urdu RTL + tiny hosting; the closest (Evershine) has an unsafe fee core and shipped debug endpoints |
| 2026-10-10 | One school per installation | Simpler isolation, backups, and mental model |
| 2026-10-10 | One product for schools and academies, via a unified "group" model | Avoid two code paths (§4) |
| 2026-10-10 | Staff login: Google sign-in, invited by owner. Optional passkey later. No WhatsApp login for staff | Free, everyone has Google; WhatsApp OTP costs Rs 4.17/login and proves SIM possession, not identity |
| 2026-10-10 | Parents: no account; private magic-link page. WhatsApp "reverse flow" sign-in possible later, only once a school has Cloud API | $0 and no password support burden |
| 2026-10-10 | Online-first; attendance works offline and syncs; money entry requires connection | Offline money = duplicate receipts |
| 2026-10-10 | Licence: AGPL-3.0 | Keeps the product free forever; lets us reuse OpenMasjidStudents (AGPL) and MIT code |
| 2026-10-10 | System of record: Cloudflare D1 (SQLite). Google Sheets only as a nightly read-only copy | Sheets has no transactions/constraints; concurrent appends drop rows |
| 2026-10-10 | Hosting: Cloudflare Workers + D1 + R2 on `conceptlix.com` subdomain for pilot | Nothing sleeps or expires on free; card on file acceptable (R2) but must remain $0 |
| 2026-10-10 | Notifications: $0 default = staff send-queue via WhatsApp + class announcement groups + parent page. Cloud API / SMS as opt-in paid adapters | Meta charges Rs ~4.17 per automated message since 1 Oct 2026 |
| 2026-10-10 | Never bundle unofficial WhatsApp automation (Baileys etc.) | ToS violation; bans reported at low volume; risks the school's known number |
| 2026-10-10 | Money stored as integer paisa; ledger is append-only; balances derived | See §5 |
| 2026-10-10 | Product name: **Maktab** | User's pick |
| 2026-10-10 | WhatsApp for pilot: manual send-queue only; Cloud API adapter deferred to v3 | User's pick; keeps $0 and avoids Meta verification |
| 2026-10-10 | Pilot starts with no existing records (fresh data entry); late fines, scholarship/merit, topper, needy/hardship, sibling and sponsored fee cases are all in scope for v1 | User confirmed these are the genuine cases |
| 2026-10-10 | Fee reduction is a plain admin action (any time: admission, mid-session, next session); no approval workflow, no automation, no caps | User: do not over-engineer; it is the admin's decision |
| 2026-10-10 | Fee collectors: any user with the accountant/admin/owner role; unlimited; every receipt records who, when, which student/family, for what | User: no fixed count |
| 2026-10-10 | Sessions are yearly (one year = one step up); English digits everywhere, even in Urdu UI; no Hijri dates; Urdu font only for Urdu text | User's pick |
| 2026-10-10 | Stack confirmed (§8): TypeScript end to end, Hono on Workers, D1/SQLite via Drizzle, Vite + React + Tailwind + shadcn PWA, Google sign-in, R2, GitHub Actions backups. Go/Rust considered: Go cannot target Workers, Rust/WASM adds a toolchain for no gain at this scale; Go would be first choice for an always-on self-hosted server, and the thin API layer keeps that port feasible later | User: "go with your own judgement" |
| 2026-10-10 | Build starts: local git repo, AGPL-3.0; GitHub publish deferred until the user says push. Milestone 0 = scaffold (schema + triggers, auth + permission matrix + tests, bilingual PWA shell, backup workflow). Opus writes, Sonnet verifies, Fable reviews | User delegated the decision |
| 2026-10-10 | **M0 closed** at `8a530c7` after two blind reviews and three clean-clone verifications: 164 tests, 58 triggers, 4 views. Added by review: payer-credit ≥ 0 invariant, allocation sign/release rule per (receipt, charge), reversal shape + single write path `reverseReceipt`, close-only cash sessions with generated variance, frozen payslip lines + salary cap, integer-money CHECKs, fee→fine→waiver two-level tree, `OWNER_EMAIL` bootstrap, matrix rows `attendance.correct` / `expense.void` / `audit.read`, forward-only custom-SQL migrations with manifest, `ledger_consistency` view (nightly alarm in M6). This file (`docs/PLAN.md`) is now canonical; the design-folder copy is a pointer | §15 loop |
| 2026-10-13 | **UI/UX polish adopted as M7b** from `docs/ui-enhancement-plan.md` + `docs/design/ui-mock.html`: "calm ledger" direction, school-in-front branding (badge, name, curated accent colour; "Runs on Maktab" line), grouped navigation + phone bottom bar, five-step setup incl. Fees, dark mode, generated badge for schools without a logo. Decisions: density 36 px on fine pointers / 44 px on touch (rule amended; verifiers emulate touch); system fonts for Latin; Fees hub = Counter/Defaulters/Billing/Cash tabs, Concessions/Sponsors/Fee register/Collection under "More" + Reports; per-school installed icon/name after the pilot; school picks its colour in setup (GSA placeholder blue). Additions owed by M7b: badge on parent page + printed receipts, teacher/accountant home variants, Urdu mirroring of the new shell, empty/loading/offline states, "Needs attention" fed by M6 alarms, install prompt, contrast/focus checks. Runs after M7a, before the pilot gate. Pilot school: **Global Science Academy, Pakpattan (GSA)** | Product-owner decision (Fable), user delegated |
| 2026-10-13 | M7b-1 deviations: teacher bottom bar = Home/Attendance/Messages (not My groups); register marks stay solid-fill for sunlight readability; per-school phone icon preview tile removed until §6.5 ships. Also: the teacher menu keeps "Dues" (their groups' dues summary) and "My payslips" (their own slip) by design — "teacher home shows no money" means no amounts of other people or of the school, not no money screens | M7b part 1 review and browser verify |
| 2026-10-13 | M7b-2 (screens) deviations: new screen strings live in `packages/shared/src/i18n-screens.ts` and are merged into i18next by the lazy screens (English `en` is in the first-load chunk; headroom ≈ 4 KB), Urdu stays in `i18n-ur`; register marks keep the solid-fill **cycle** (M7b-1 decision) rather than four direct buttons; cards app-wide take the Panel look instead of rewriting Billing/Cash/Concessions/Sponsors/Fee register/Advances/Reports onto `Panel` one by one; Fees hub tabs are links (each tab is its own URL); two additive API reads: `GET /api/messages?family_id=` (inside message scope) and owner-only `GET /api/home/first-week` (yes/no facts), plus `family_id` on dashboard absentees; secondary screens shot in 4 variants (each axis covered) instead of 8, PNGs palette-quantised | M7b part 2 build |
| 2026-10-13 | M7b-2 fix pass deviations: the student profile header has no "Message" or "Change photo" action yet (deferred: messaging a family stays in the Messages queue and the photo is still changed from the Overview tab's photo picker until the header gets its own upload flow); the Fee register asks for a class before it loads anything (no default class); the billing run history shows the latest 6 chunks with "Show all"; Billing's Re-open and Apply fines keep their one-click behaviour (no new confirm step, money rules unchanged); Sponsors and Expenses got the light pass only (Panel/StatStrip/FeesTabs; DataTable phone cards with a wider label column) | M7b part 2 review |
| 2026-10-13 | M7b screens fix pass deviations: the Sent button is hidden (not disabled) until Open; 'archive' is labelled 'Move to recycle bin' | M7b screens fix pass |
| 2026-10-13 | maktab.conceptlix.com = demo; GSA pilot = maktab-gsap.conceptlix.com; later GSA's own account behind a front-door Worker (M8) | The first production host becomes the public demo (DEMO_MODE, made-up "Al-Noor Community School", nightly reset; docs/demo.md); GSA starts empty on its own Worker, D1, R2 bucket and secrets, and the nightly backup follows it (docs/deploy.md) |
| 2026-10-14 | **Two instances:** `maktab.conceptlix.com` = public demo (demo mode, fictional Al-Noor Community School, one-tap demo sign-ins, undo-log reset at 02:00 PKT, no fee cron); `maktab-gsap.conceptlix.com` = GSA pilot (empty; owner shahid.ics.pu@gmail.com onboards himself with the in-app guide); backups target `maktab-gsap`. **Help & Guide** merged (25 tasks, 17 tours, content generates `docs/onboarding.md`). **D1 quota lesson:** the first demo seed hit the account-wide 100k writes/day (a `charge` row costs ~10 writes with its 9 indexes; a register day ≈ 420) → seed budgeted at ≤ 33k writes (135 students, one week of registers, six months of money), reset is an undo-log replay capped at 20k, demo pauses on a quota error until 00:00 UTC; GSA shares the quota. Remote reseed pending the counter reset | Fable |
| 2026-10-14 | **Google Cloud free tier evaluated** (user asked): no free SQL; Always Free needs a billing account + card and bills on overage (budgets only alert); free quotas only in US regions (~250–350 ms from Pakistan); Firestore would need a rewrite and its 20k writes/day sits at our usage. Verdict: hosting stays on Cloudflare (or self-host); Cloud Storage acceptable only as a third backup copy; B2 remains the second. Google for Nonprofits/Workspace for Education eligibility in Pakistan unverified | Research (Sonnet), Fable |
| 2026-10-14 | Demo dated from its seed day; weekly full reseed on **Monday** 02:00 PKT (and the 1st of each month), the nightly undo otherwise | The owner asked for Sunday; Sunday is the weekly off, so a Sunday seed day has no counter or registers "today". The 1st bills the new month. ≤ ~6 reseeds a month at ~33k writes each, one a UTC day |

## 3. Who uses it

| Role | Typical person | Device | Main screens |
|---|---|---|---|
| Owner / Principal | runs the school | laptop + phone | dashboard, settings, staff, approvals, reports, backup |
| Accountant / Office | 1–N fee collectors | laptop or phone | fee counter, receipts, cash closing, expenses, send queue |
| Teacher | class/subject teacher | phone | today's attendance, marks entry, their timetable, send absence alerts |
| Parent / Guardian | low-end Android, WhatsApp | phone | magic-link page only (attendance, dues, receipts, results, notices) |
| Sponsor (later) | donor funding students | — | statement of sponsored students |

No hard limit on number of collectors, teachers, or groups.

## 4. Product concept: one model for schools and academies

Studied: Gibbon, RosarioSIS, Frappe Education (v15 and develop), skuul. The unifying idea is Frappe's *Student Group* + RosarioSIS's dated enrolment rows + Gibbon's family.

- **Programme** — what is taught: "Class 5" (kind=grade, points to next programme "Class 6") or "FSc Pre-Medical" (kind=course, duration).
- **Group** — where students sit: "5-B in session 2026-27" or "Morning batch, Mon–Fri 08:00–12:00, capacity 40". Has class teacher, optional subjects each with a teacher, optional next-group pointer for promotion.
- **Enrolment** — dated link student→group with status `active | promoted | retained | completed | withdrawn | transferred` and reason (`transferred` = moved to another group, the new row links back; `withdrawn` = left the school). History = chain of rows.
- **The one rule:** at most one *active primary* enrolment per student (the school class); any number of non-primary (batches, short courses). Enforced by a partial unique index.
- **Family** — siblings share guardians, one dues view, one receipt per visit, one message per household.

School setup picks mode `school | academy | both`; this changes labels and visible screens only.

Scenario mapping:
- Class 5-B promoted → close enrolment (`promoted`), open one in `next_group`; retained → next year's 5-B.
- FSc batch with 3 subject teachers → one group, three `group_subject` rows; attendance per day or per subject.
- Student in Matric evening + 3-month English → two non-primary enrolments.
- Small school with no sections → one group per class; UI hides the section label.

## 5. Data model (SQLite / D1)

Conventions: ids are client-generatable ULIDs; every row has `created_at`, `created_by`; money is `INTEGER` paisa; dates are ISO text in Asia/Karachi; soft-delete only on non-money reference data; **money tables have no UPDATE/DELETE** (enforced by triggers).

### 5.1 Academic
```
session(id, name, start_date, end_date, is_current)
term(id, session_id, name, seq, start_date, end_date)
programme(id, name, kind 'grade'|'course', seq, next_programme_id, duration_weeks)
subject(id, name, short_name)
grp(id, programme_id, session_id NULL, name, is_primary, class_teacher_id, start_date, end_date,
    capacity, days, start_time, end_time, room, next_grp_id, status 'open'|'running'|'closed')
grp_subject(id, grp_id, subject_id, teacher_id)
enrolment(id, student_id, grp_id, is_primary, roll_no, start_date, end_date,
          status 'active'|'promoted'|'retained'|'completed'|'withdrawn'|'transferred', end_reason, prev_enrolment_id)
  UNIQUE one_primary ON enrolment(student_id) WHERE is_primary=1 AND status='active'
family(id, name, address, area)
guardian(id, family_id, name, relation, cnic, phone, whatsapp, priority, consent_whatsapp, consent_sms, lang)
student(id, family_id, admission_no, name, father_name, dob, gender, b_form_no, photo_key,
        admission_date, status 'active'|'left'|'graduated', left_date, left_reason, extra JSON)
staff(id, user_id NULL, name, phone, role, joined, status, extra JSON)
att_register(id, client_id UNIQUE, grp_id, date, grp_subject_id DEFAULT 0, taken_by, taken_at, received_at)  -- history: one row per submission ever received
att_mark(register_id, student_id, status 'P'|'A'|'L'|'E', note)  PK(register_id, student_id)
current_register(grp_id, date, grp_subject_id, register_id, taken_at)  PK(grp_id, date, grp_subject_id)
  -- pointer moves only if new.taken_at > current.taken_at (client time), so a stale offline submission never overwrites a later office correction
staff_att(staff_id, date, status, note)
grade_scale(id, name); grade_band(scale_id, min_pct, grade, remark)
exam(id, name, term_id, grp_id, date_from, status 'draft'|'published')
exam_paper(id, exam_id, subject_id, max_marks, pass_marks, weight)
mark(paper_id, student_id, obtained NULL, is_absent)
slot(id, grp_id, weekday, start_time, end_time, grp_subject_id, room)   -- clash check in app + unique index
custom_field(id, entity, key, label_en, label_ur, type)                  -- values live in `extra` JSON
audit(id, at, user_id, entity, entity_id, action, diff JSON)
```

### 5.2 Money (ledger)
Sources: OpenMasjidStudents (ledger, family, idempotency, integer money), CoachSync (reversal-with-replacement, void-with-reason, cash snapshot), academico (discount as visible negative line, numbered series), Evershine (penalty lifecycle, maker-checker on salary).

```
fee_head(id, name, kind 'admission'|'tuition'|'exam'|'course'|'misc'|'fine', cadence 'monthly'|'once'|'per_term')
fee_rate(id, fee_head_id, programme_id|grp_id, amount, effective_from)          -- versioned, never edited
concession(id, student_id, fee_head_id NULL, type 'pct'|'fixed', value,
           reason 'sibling'|'orphan'|'staff_child'|'scholarship'|'topper'|'needy'|'other', note, approved_by, valid_from, valid_to,
           ended_at, ended_by, end_reason)                                          -- never edited; end + new row to change
sponsor(id, name, phone); sponsorship(id, sponsor_id, student_id, fee_head_id NULL, share_pct, valid_from, valid_to)
billing_run(id, period_key UNIQUE, run_at, run_by, note)
charge(id, student_id, enrolment_id, fee_head_id, period_key, payer_type 'family'|'sponsor', payer_id,
       amount SIGNED, due_date, kind 'fee'|'concession'|'fine'|'fine_waiver'|'reversal', parent_charge_id, reason, run_id)
  UNIQUE (student_id, fee_head_id, period_key, payer_id) WHERE kind='fee'   -- idempotent generation
opening_balance(student_id, amount, as_of, note)                                 -- go-live carry-in, once
receipt_series(series, year, next_no)
receipt(id, receipt_no UNIQUE, kind 'payment'|'reversal'|'refund', reverses_id UNIQUE, payer_type, payer_id,
        amount, method 'cash'|'bank'|'jazzcash'|'easypaisa', account_id, collector_id, cash_session_id,
        business_date, idempotency_key UNIQUE, reference, note)
  CHECK (kind='reversal') = (reverses_id IS NOT NULL AND amount < 0)
receipt_allocation(receipt_id, charge_id, amount SIGNED)                           -- append-only
account(id, name, kind 'cash'|'bank'|'wallet', holder_staff_id, opening_balance, opening_as_of)  -- holder and opening frozen once money moved
cash_session(id, collector_id, business_date, opening, expected, counted, variance, closed_at, closed_by)  UNIQUE(collector_id, business_date)
transfer(id, from_account, to_account, amount, date, note)                        -- never in P&L
expense(id, expense_no, category_id, account_id, cash_session_id, amount, vendor, date, note, voided_by, void_reason)
payslip(id, staff_id, period_key, status 'draft'|'approved'|'paid', approved_by)  UNIQUE(staff_id, period_key)
payslip_line(payslip_id, kind 'basic'|'allowance'|'deduction'|'advance_recovery', amount, note)
staff_advance(id, staff_id, amount, account_id, date)                             -- receivable, not expense
salary_payment(id, payslip_id, amount, account_id, date)
```

Invariants (enforced by triggers where SQLite can, else by the single write path):
- Σ allocation per receipt ≤ receipt amount; Σ allocation per charge ≤ charge net. A trigger `RAISE(ABORT)` on violation rolls back the whole D1 batch.
- Advance credit = receipt amount − allocations (derived). Unallocated credit auto-applies to future charges; past allocations never move, so a printed receipt never changes meaning.
- Paid / partial / overdue are **computed** from charges, allocations and today's date. Nothing stores a balance. Net is computed per **root** charge (`parent_charge_id IS NULL`) as the sum of itself and its child lines (concession, fine, fine_waiver, reversal); child lines are never listed as separate dues. Allocations always target the root charge.
- Income = Σ receipts (reversals net out), split by fee head via allocations; expense = Σ non-void expenses + Σ payslip **pay = earnings − deductions** of approved/paid slips, by the slip's month — what the school owes its staff for that month (M4 fix pass decision: a deduction such as unpaid leave is pay not owed; advance recovery is not a deduction, it settles a receivable; there is no withholding/tax line kind). Transfers, advances, concessions and account opening balances are excluded by construction → P&L cannot double-count.
- Receipt write = one D1 batch: `UPDATE receipt_series … ; INSERT receipt … SELECT next_no …; INSERT allocations …`. Client-generated receipt id and idempotency key make retries safe.

Monthly generation: cron with catch-up + manual button; only active enrolments; session months only; mid-month joiner → explicit choice (full / pro-rata / backfill due today); leaver → `end_date` stops future runs; late fine = `fine` charge with `parent_charge_id`, unique per parent and period, waived by `fine_waiver`.

### 5.3 Messaging
```
message(id, family_id, guardian_id, channel 'wa_manual'|'wa_api'|'sms'|'push'|'email', template_key, lang,
        payload JSON, link_token, status 'queued'|'sent'|'delivered'|'read'|'failed'|'skipped',
        provider_ref, raw_response, cost_estimate, cost_actual, created_at, sent_at, error)
reminder_state(family_id, template_key, last_sent_on)       -- cooldown; one message per household
parent_link(id, guardian_id, token_hash, expires_at, revoked_at, last_seen_at)
```
M5 additions (migrations 0019–0020): `message.rendered_text, opened_at, sent_by, skipped_reason, skipped_at` + index `(family_id, template_key)`; `message_template(key, lang, body, updated_by, updated_at)` seeded with `DEFAULT_TEMPLATES` (`@maktab/shared`); `parent_link.token_salt, gate, pin_hash, gate_failures, gate_locked_until` (one live link per guardian: partial unique index); `parent_link_access(id, link_id, at, ip_hash, ua)` capped at 50 rows per link; `school.parent_gate, announcement_groups_note`. Triggers: a message leaves `queued` once (sent with a time, skipped with a reason) and never returns; a parent link's token is never edited, a revocation is final, links are never deleted. The link token is `HMAC(PARENT_LINK_SECRET, salt)` (salt = 128 random bits; its own Worker secret since the M5 fix pass, never `SESSION_SECRET`) and only its SHA-256 is stored: the Worker can recompute a guardian's current link for `{link}`, a DB leak alone gives no working link. Gate tokens, PIN hashes and access-log IP hashes are HMACs under the same secret. **No live link at rest:** `message.rendered_text` keeps `{link}` in place of the link; only the `POST /api/messages/:id/open` response (and the one-time URL from `POST /api/guardians/:id/parent-link`) carries it, so lists, rows and backups never do. Migration 0021 (fix pass): `parent_link.gate_last_attempt_at`, indexes `message(status, sent_at)` / `(status, skipped_at)`, the existing school moved to the birth-year gate, notice/absence templates updated.

### 5.4 Auth
```
user(id, email UNIQUE, name, google_sub, status 'invited'|'active'|'disabled', created_by)
role(user_id, role 'owner'|'admin'|'accountant'|'teacher')
session(id, user_id, expires_at, ua, ip)
```
Permission model (user-confirmed 2026-10-10: teachers must never see other staff's salary; only admin controls that):
- **Default deny.** Every API route declares the permission it needs; an undeclared route cannot be reached.
- **Role × resource × action** matrix, static and typed in code (so it is reviewable in one file and tested), with these roles: `owner` (everything, incl. roles and backups), `admin` (all operations, no backup/role changes), `accountant` (fees, receipts, cash, expenses, payslips), `teacher` (own groups only), `parent` (magic link, read-only, own children).
- **Row scope on every query**, not just role: a teacher's queries are filtered to groups where they are class teacher or subject teacher; a parent link to its guardian's children; an accountant to all students but not to payroll of `owner`. Scope is applied in the data layer so a forgotten UI check cannot leak.
- **Field scope:** salary, CNIC, B-form and phone numbers are returned only to roles that need them; the teacher endpoint for "my payslip" returns only `staff_id = me`. Lists mask CNIC.
- **Owner pay (M4 fix pass):** a caller without `payslip.read = all` (the accountant) sees money reports with owner-role staff left out of salaries and net, labelled "Salaries (excluding management)" (en/ur) — income vs expense, the month dashboard tile and their CSVs; the reconciliation block is reduced to `ties`. In the cashbook an owner's salary or advance row is shown as kind `owner_draw`, party "—", no reference. **The amount stays**: it is a real movement of a bank account or drawer the accountant may reconcile against statements, so an owner's pay can be inferred from a bank line by someone who looks for it; the masking hides who and what, not that money left. Owners who want full privacy are paid from an account the accountant cannot see (not modelled in v1).
- **Separation of duties:** a reversal or void needs `admin`/`owner`; a collector cannot reverse their own receipt without an admin; payslip approval is `owner`/`admin`, payment is `accountant`.
- **Audit everything** (who, what, before/after) and show the audit trail to `owner`.
- **Tests:** a permission test suite that calls every route as every role and asserts allow/deny, plus scope tests (teacher A cannot read teacher B's groups, marks, or payslip).

| Resource → Action | owner | admin | accountant | teacher | parent |
|---|---|---|---|---|---|
| Students / families: read | all | all | all | own groups | own children |
| Students / families: write | ✓ | ✓ | ✓ | – | – |
| Attendance: mark / correct | ✓ / ✓ | ✓ / ✓ | – | own groups / – | read own |
| Fees: generate, concessions | ✓ | ✓ | – | – | – |
| Receipts: create | ✓ | ✓ | ✓ | – | – |
| Receipts: reverse | ✓ | ✓ | – | – | – |
| Cash session: close own / reopen any | ✓ / ✓ | ✓ / ✓ | ✓ / – | – | – |
| Expenses: create / void | ✓ / ✓ | ✓ / ✓ | ✓ / – | – | – |
| Payslips: read | all | all | all except owner | **own only** | – |
| Payslips: approve / pay | ✓ / ✓ | ✓ / ✓ | – / ✓ | – | – |
| Exams: marks entry | ✓ | ✓ | – | own subjects | read own |
| Send queue | ✓ | ✓ | ✓ | own groups | – |
| Settings, roles, backups | ✓ | settings only | – | – | – |
| Audit trail: read | ✓ | – | – | – | – |

## 6. Feature scope

### v1 — pilot ("replace the paper registers")
Ordered by what the school touches daily:
1. Setup wizard (mode, session, programmes, groups, fee heads/rates), owner invites staff by Google email.
2. Students & families: admission form with photo (compressed client-side ≤100 KB), guardians with WhatsApp consent, CSV import, opening balances.
3. Attendance: one group per screen, all present by default, tap absentees; offline queue; absentee send-queue.
4. Fees: monthly generation, fee counter (family view, oldest-first allocation, part/advance payments), numbered receipt (print/PDF/share), concessions with reason & approver, defaulter list by group with "remind all" queue, cash closing per collector.
5. Expenses and salary (payslips, advances), income vs expense report.
6. Parent page (magic link), WhatsApp send queue with Urdu templates, class announcement groups guidance.
7. Dashboard: today's collection, absentees, dues, month P&L.
8. Urdu/English UI, RTL; backups (Time Travel + nightly dump + nightly Sheet + owner "download everything").
9. Audit log, recycle bin for reference data.

### v2 — academics and documents
Exams, grading scales, report cards (Urdu/English), position/rank at report time; timetable grid with clash checks; year-end promotion wizard; leaving/character certificates; ID cards with QR; staff attendance; admission inquiries; payment-proof upload + verification for bank/wallet deposits; sponsor statements; thermal receipt printing (Web Bluetooth ESC/POS) if the pilot wants it.

### v3 — automation and apps
Cloud API WhatsApp adapter (school's own Meta credentials), SMS adapter (semi-branded or Android gateway), web push for staff, Capacitor builds for Play Store / iOS, optional parent sign-in via WhatsApp reverse flow, homework/diary, library/uniform stock, transport.

## 7. Notifications

Every outgoing message is a row in `message`; channel adapters sit behind one interface with per-guardian preference and fallback order.

| Stage | Channel | Cost (300 / 1,000 students) | Notes |
|---|---|---|---|
| Default | Staff send-queue: app prepares Urdu text + link, staff taps Open WhatsApp → Send → Next from the school phone | $0 | ~2 min for 15 absences; spread fee reminders across class teachers |
| Default | Class announcement groups / WhatsApp Community | $0 | holidays, notices; members see each other's numbers |
| Default | Parent magic-link page with "listen" (TTS) button | $0 | content destination for every message |
| Optional | SMS for the ~10% without WhatsApp: semi-branded (Rs 4.00–4.10, CNIC + letterhead) or Android SMS gateway on the school SIM (≤~200/day) | Rs 200–400 / 500–1,300 | Urdu SMS = 70 chars/segment; prefer short Roman Urdu + link |
| Optional | WhatsApp Cloud API utility templates (Pakistan: $0.015 ≈ Rs 4.17 per delivered message since 1 Oct 2026; 1,000 free service messages/month per number) | ~$5–15 / $17–50 | needs Meta Business portfolio; unverified = 250 unique recipients/day; business verification needs registration documents + website |
| Never | Unofficial WhatsApp-Web automation | — | ToS breach, ban reports at low volume |

Cost reducers: one message per family; "pull" model (parent sends RECEIPT/RESULT → free service reply) for non-urgent content; push only absence and fee due.

Magic-link page: ≥128-bit token stored hashed, long-lived but revocable/rotatable by staff, rate-limited, `noindex`, no-referrer, shows calling name (first name, or Muhammad + the next name when the name has three or more words)/class/attendance/dues/receipts/results only, optional second factor (birth year or PIN) before results/receipts, access log visible to staff.

## 8. Architecture

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript, Tailwind, shadcn/ui, i18n with Urdu RTL, installable PWA (service worker, IndexedDB outbox for attendance) | Modern minimal UI, one codebase for web and later Capacitor builds |
| API | Hono on Cloudflare Workers; Zod schemas shared with the frontend | Tiny, portable (runs on Node/Bun too) |
| DB access | Drizzle ORM (D1 driver in prod, better-sqlite3/libsql locally) + Drizzle migrations | Same schema runs on D1 **and** on a VM/homelab SQLite file → no lock-in to the free tier |
| Files | R2 (student photos, uploaded payment proofs). PDFs generated on demand, not stored | 10 GB free; card on file required |
| Auth | Google OAuth code flow in the Worker (ID token verified with WebCrypto), HMAC session cookie; owner invites emails; Turnstile on public endpoints | Free; within 10 ms CPU |
| Printing | Browser print of styled HTML (receipts, cards, report cards) with Noto Nastaliq Urdu | JS PDF libraries mangle Urdu shaping |
| Scheduled jobs | Workers cron (≤5): monthly fee generation, reminder cooldowns, link expiry. Heavy jobs (DB dump, Sheet export) run from **GitHub Actions** nightly | Free Worker cron has 10 ms CPU; Actions has no such limit and is a second provider |
| Domain | `<school>.conceptlix.com` for pilot; a school's own domain later via its own Cloudflare zone | Workers custom domains are free |

Free-tier headroom (verified 2026-10-10): Workers 100k req/day, 10 ms CPU, 50 subrequests, 5 crons; D1 5M row reads / 100k row writes per day, 500 MB per DB, Time Travel 7 days; R2 10 GB. Expected use at 1,000 students: ~10–20k row writes/day (incl. index + audit; measured ≈1.75 rows_written per inserted row). Measured remote write-batch latency ≈ 140–165 ms; read-only requests ≈ 40 ms from Pakistan. Design rules that follow: no client polling; bulk inserts via `json_each(?)` (100 bound-parameter limit); timezone handling explicit (D1 quotas reset at 00:00 UTC, school day is Asia/Karachi).

Portability requirement: `docker compose up` must run the same app on one VM/homelab with a SQLite file and local disk, as the escape hatch if Cloudflare's free tier changes.

## 9. Resilience and backups

| Layer | What | Where | Depends on homelab? |
|---|---|---|---|
| 1 | D1 Time Travel, per-minute restore, 7 days | Cloudflare | no |
| 2 | Nightly `wrangler d1 export` from GitHub Actions → `age`-encrypted → R2 **and** Backblaze B2 (10 GB free, different provider) | two clouds | no |
| 3 | Nightly one-way export of key tables to a Google Sheet the school owns (service account as Editor, school's Drive) | school's Google | no |
| 4 | Homelab pulls the encrypted dump nightly (rclone) | your PC | optional extra |
| 5 | Owner's "Download everything" button (CSV zip + SQL) | school's device | no |

Rules: export runs at night (it blocks the DB); restore drill once per term, documented; encryption key held by owner + one escrow copy; retention 90 daily + 24 monthly.

## 10. Security baseline

HTTPS only; Google sign-in with invite allowlist; role + row scoping on every query; default-deny routing (no debug/seed endpoints in prod); Turnstile + Cloudflare rate-limit rules on public routes (parent page, OAuth callback); audit on all writes; secrets only in Worker bindings; encrypted backups; parent page shows minimal data; CNIC/B-form masked in lists; no public R2 bucket (signed URLs).

## 11. UI principles

Phone-first for attendance, fee counter and send queue; laptop for setup and reports. One primary action per screen. Urdu is a first-class locale (Noto Nastaliq Urdu for print; test UI density on a 5.5" Android). Numbers always in English digits (0–9), including in the Urdu UI; Gregorian dates only. Light/dark. Empty states that teach. No destructive buttons on list rows (money rows have no delete at all).

## 12. Open questions and experiments (before code)

Experiments (each ≤ 1 day, result goes in this file):
1. **Atomic receipt on D1** — **PASSED 2026-10-10** on sqlite3 3.51 and on local D1 (wrangler 4.149, workerd 2026-10-06). Verified: a batch whose last statement trips a `RAISE(ABORT)` trigger leaves no receipt and does not advance the series; partial unique index, CHECK, views, `INSERT…SELECT` numbering, `RETURNING`, idempotency key, reversal + double-reversal guard all behave; two concurrent batches on one charge → one succeeds, one fails, series gap-free; 40 rows inserted via one `json_each(?)` parameter (101 bound params fails). Design fix found: net must be computed on **root charges only** (child concession/fine/waiver lines folded into the parent), else fines double-count. **Remote D1 confirmed 2026-10-10** on the real account: batch rollback, triggers, partial index, CHECK, `RETURNING`, idempotency, FK enforcement (`PRAGMA foreign_keys`=1) all identical to local. True cross-request race: 10 parallel HTTPS requests against one charge with room for 3 → exactly 3 succeeded, 7 failed on the trigger, `sum(allocations)` never exceeded net, series contiguous 00001–00106 with no gaps or duplicates. **Latency: ~140–165 ms per write batch** (primary-region write from Pakistan); design rule: one `batch()` per user action, client retries on trigger error, optimistic UI. `rows_written` counts index writes: 40 rows → 80 written (≈1.75× in the full schema). Trigger errors surface as `SQLITE_CONSTRAINT_TRIGGER` with the message text; app code matches on the text. Files: scratchpad `exp1/`, `exp1-d1/` (throwaway).
2. **Auth CPU budget** — **PASSED 2026-10-10** on local workerd (not the enforcing runtime; confirm after first deploy via Observability CPU p99). External wall-clock per request: RS256 ID-token verify + claim checks ≈ 1.2 ms median (≈ 0.3 ms over the 0.9 ms empty-handler baseline); HMAC session issue/verify ≈ 1.0 ms. Bundle 7.4 KiB, no `nodejs_compat`. **Remote confirmed 2026-10-10** via `wrangler tail` cpuTime: /verify 0–1 ms, HMAC 0–1 ms, cold RSA keygen 1 ms (end-to-end ≈ 41 ms median from Pakistan, of which ~40 ms is network). Negative control: PBKDF2 at 100k iterations = **22–38 ms CPU on the real runtime**, 3–4× the nominal 10 ms, yet single calls were tolerated (`outcome: ok`); a 500-iteration loop (~2 s) returned error 1102. So the limit is enforced with slack, not per-request hard — do not rely on that: passwords stay out; Google sign-in + passkeys only. Before shipping: JWKS cache needs a TTL and a refresh-on-unknown-`kid`; the live Google JWKS fetch path was coded but not exercised. Files: scratchpad `exp2/` (throwaway).
3. **Urdu print** — **desktop half PASSED 2026-10-10** (headless Chrome; Fable inspected the Urdu A5 receipt and Urdu report card renders). Noto Nastaliq Urdu VF (OFL 1.1, 676 KB TTF, ~361 KB gzip) shapes correctly; no clipped diacritics at `line-height: 2.0`; RTL tables in correct column order; Latin digits and `PKR 5,700` intact; `-PKR 500` renders as one unit; report card fits one A4 page. Fixes that become rules: (1) every number/date/amount sits in `<bdi>`/`.num` with `unicode-bidi: isolate; direction: ltr; font-family: system-ui` (Nastaliq renders Latin digits badly); (2) Urdu data inside an English page gets `lang="ur" dir="rtl"` and `line-height: 2.1`; (3) `@page { size: 58mm auto }` is invalid in Chrome → use `58mm <measured>mm` injected at load; thermal height still overshoots and needs tightening; (4) wait for `document.fonts.ready` before `window.print()`. Font strategy: self-host a WOFF2 subset (Arabic blocks + presentation forms, `--layout-features='*'`), `font-display: swap`, preload only when `lang=ur` or printing, cache in the service worker. **Still needs Android:** Chrome print dialog honouring `@page` 58 mm, real 203 dpi thermal output (likely needs bitmap/ESC-POS or a vendor app), subset load time on 3G, share-sheet to WhatsApp. Files: `experiments/exp3/`.
4. **Send queue** — **desktop half PASSED 2026-10-10** (prototype in scratchpad `exp4/`, 5/5 Node tests). Number normaliser handles `0300…`, `0300-…`, `+92 300…`, `92 300…`, `300…`, `0092…` and Urdu digits → `923001234567`; rejects landlines/non-PK. Longest Urdu URL 759 chars (safe under ~2,000). 412 px layout verified by screenshot: Nastaliq preview, Latin digits, isolated LTR numbers, ≥44 px targets. Decisions: (1) `sent` is only ever an explicit tap; returning from WhatsApp proves nothing → offer a combined "Sent & Next" button; (2) the parent link goes alone on the last line of every template to avoid bidi reordering around it; (3) WhatsApp requires a PK mobile number; landlines are stored but routed to "call" only. **Still needs Android Chrome:** wa.me opens the app with full Urdu text intact; return-to-app keeps the tab/PWA alive and localStorage; `navigator.share({files})` offers WhatsApp and attaches the PDF (requires HTTPS). wa.me behaviour claims are from memory, not re-verified against the WhatsApp FAQ.
5. **Backup drill** — **local half PASSED 2026-10-10**; cloud half authored, not run. Synthetic 1,000-student year (282k rows incl. 220k attendance marks): SQLite 7.8 MB; `d1 export` 2.1 s → 28 MB SQL (one INSERT per row) → gzip 1.2 MB → AES-256-GCM (WebCrypto script; `age` not installed) 0.04 s; restore into fresh D1 113 s (~2,500 statements/s); all 8 tables identical by count and sha256 of ordered rows; `integrity_check` ok; triggers, views and partial indexes survive export/import (dump orders data before triggers, so append-only triggers never block a reload). Extrapolation: ~8–40 MB/year → 500 MB cap is 12+ years away; restore time, not storage, is the constraint (~20 min for a 10-year dump). Authored: `experiments/exp5/.github/workflows/nightly-backup.yml` (21:30 UTC export → gzip → `gzip -t` → age encrypt → sha256 + size-regression check → R2 + B2 → prune 90 daily/24 monthly → failure issue), `restore.md` (Time Travel path + fresh-D1 path + re-point binding), `sheets-export.md`. Rules adopted: verification in CI never decrypts (private key stays with owner); R2 pruning via lifecycle rules, not the job. **Remote confirmed 2026-10-10:** 8,220-row import in 3 chunks ≈ 4 s each, no limits hit; full `d1 export --remote` 7.3 s → 1.1 MB; `--table=` works. **Finding:** queries issued *during* a remote export failed with D1 internal error 7500 in 1 of 4 and 2 of 3 attempts → the app must tolerate transient 7500s (retry once), the export runs at 02:30 PKT, and health checks must not page on it. `d1 info rows_written_24h` lags and cannot be used to measure quota consumption. Still needs: API token (D1 Edit, R2 Edit) as a GitHub secret, R2 + B2 buckets, first real Actions run.
6. **Offline attendance** — **PASSED 2026-10-10** on fake-indexeddb + local D1 (10/10 scenarios, 8 consecutive green runs; chaos run of 50 submissions with ~30% drops and ~10% duplicates ends with exactly one current register per key and the last-applied marks). Protocol: outbox entries keyed by ULID `client_id`; per-key ordering (a newer submission waits while an older one for the same group/date is backing off); backoff 1→60 s; 4xx → `failed` (not retried), 5xx → retry; each submission is one 5-statement batch using `INSERT OR IGNORE` + `json_each(?1)` + a request nonce to detect "this call created the row" without read-then-write. 40 marks = 1.8 KB. Decision taken: pointer moves by client `taken_at`, not server arrival. Still needs a real Android Chrome run (persist(), airplane mode, swipe-away, reopen, reconnect; USB remote debugging) — see agent notes in scratchpad `exp6/`. Triggers: `online`, `visibilitychange`, timer; don't rely on Background Sync.

Decisions still open:
- Pilot school: school / academy / both; registered entity (only matters for v3 Cloud API).
- Deferred to v3: Cloud API number (existing vs second SIM); Meta non-profit exemption.

## 13. Review notes (Fable, 2026-10-10) on the Opus draft

Confirmed: build-fresh verdict; D1 as system of record; Sheets as copy only; $0 notification default; AGPL; unified group model; ledger design.

Corrected / tightened:
- **Nightly dump from a free Worker cron is not realistic** (10 ms CPU per cron, verified). Moved dumps and the Sheet export to GitHub Actions; this also puts orchestration with a second provider.
- **Receipt atomicity has a concrete answer**: client-generated ids + `INSERT…SELECT` for the number + abort triggers inside one `batch()`; Durable Objects remain the fallback only if triggers misbehave on D1 (experiment 1).
- **Portability is a requirement, not a nice-to-have**: Drizzle + Hono so the same code runs on a homelab SQLite file. Free tiers change.
- **Added** explicit timezone rule, bound-parameter limit rule, no-polling rule, thermal printing as a v2 item, custom fields table, consent fields on guardian, sponsor statements, restore-drill cadence, Google OAuth note (openid/email/profile scopes need no verification; publish the consent screen so tokens don't expire after 7 days in Testing).
- **Reordered v1** so attendance and fees land first; salary/expenses stay in v1 but last.

Still unverified (secondary sources): R2 card requirement wording on an official page; Turso archive rule; coexistence for +92 numbers; Meta non-profit exemption scope; whether D1 index writes count toward the write quota.

## 14. v1 screen flows

Conventions: every write is idempotent (client id); every money write shows a confirmation with the resulting balance; Urdu labels on every field; destructive actions need a reason. "Phone" = designed for a 5.5" Android first.

### 14.1 First run (owner, laptop)
1. Owner signs in with Google → becomes `owner` (first user only; later sign-ins need an invite).
2. Wizard: school name/logo/address/phone → mode (school / academy / both) → session dates → programmes (prefilled Pakistani ladder: Nursery…Class 10, FSc/ICS/FA as courses; editable) → groups per programme (sections or batches, with capacity/days/time) → fee heads and rates per programme (admission, monthly tuition, exam, misc) → late-fine rule (grace day, fixed or %, cap, on/off) → receipt series prefix → language default.
3. Invite staff: email + role (+ groups for teachers). Invited user signs in with that Google email and lands on their home screen.
Rules: wizard is re-enterable from Settings; nothing here is money, so edits are allowed and audited.

### 14.2 Admission (office, phone or laptop)
1. Search families by guardian phone first ("is this a sibling?"). Match → reuse family; else new family (name, area, address).
2. Guardians: name, relation, phone, WhatsApp (same by default), language, **consent to receive messages** checkbox, contact priority.
3. Student: name, father name, gender, DOB, B-form, photo (camera → client-side resize ≤100 KB → R2), admission number (auto, editable), admission date, custom fields.
4. Enrol: pick group (primary for school classes; non-primary for batches); roll number auto.
5. Fees preview: shows admission fee + current month tuition that will be charged, with any sibling concession suggested automatically (rule in settings: nth child x%). Office confirms → charges created → optional "collect now" jumps to Fee counter.
Edge cases: mid-month joiner → prompt full / pro-rata / backfill; re-admission of a left student → reactivate, new enrolment, same family ledger.

### 14.3 Attendance (teacher, phone)
1. Home shows today's groups for this teacher with a "not taken" badge.
2. Tap group → list with photos, all **Present** by default; tap to cycle A / L / E; optional note; big "Save" button.
3. Saved offline if no network (outbox), banner "will sync"; sync retries until acknowledged; the register's `client_id` makes re-submits harmless.
4. After save: "Send absence alerts (n)" → opens the Send queue filtered to today's absentees (15.9). Guardian without WhatsApp consent is listed as "call".
Rules: a register per group per day (per subject if the school enables it); office can edit a register with reason (audit); monthly attendance % computed, never stored.
Limits (M2 fix pass): ≤ 200 marks per register and per sync request, ≤ 3 registers per request (the outbox packs greedily); a phone clock more than 5 min ahead is refused (`clock_skew`, "fix your phone's clock"), within that window `taken_at` is clamped to server time (raw value kept in the audit row). A subject teacher who is not the class teacher submits only their own subject's register. Offline reload: the service worker keeps `/api/me`, `/api/school`, today's list and opened rosters in a NetworkFirst cache (`apps/web/src/offline/api-cache.ts`), cleared on sign-out.

### 14.4 Fee counter (collector, phone or laptop)
1. Search by student name, admission no., or guardian phone → **family view**: each child with open charges (month, head, gross, concession, fine, net, paid, due), total family due, unallocated credit.
2. Enter amount received, method (cash / bank / JazzCash / EasyPaisa + reference), business date (default today, locked if the session is closed).
3. Allocation preview: oldest due first across the family; collector may redirect (e.g., "only Ali's March"); remainder becomes credit.
4. Confirm → receipt number issued → receipt screen: print, save PDF, "send on WhatsApp" (prefilled text + parent link), done.
5. Reversal: from the receipt, "Reverse" with reason → negative receipt, allocations mirrored; optional "re-enter correctly" in the same step.
Rules: one receipt per family visit; over-payment is allowed and shown as credit; no edit of amount after confirm; collector must have an open cash session (auto-opened on first receipt of the day). Any user with accountant/admin/owner role can collect; the receipt permanently records collector, time, payer, student(s), and the charges it settled.
M3a fix pass: business date is today (Asia/Karachi); only an owner/admin may enter yesterday, with a reason that is audited — anything else is `bad_business_date`. A drawer session is never opened for a past day: cash always goes into today's session, and the receipt's series year is never earlier than today's. Cash needs the session and the series number taken in the same batch (trigger); non-cash methods (bank, JazzCash, EasyPaisa, cheque, other) name the account and open no session. The family view returns `dues_hash`; the counter sends it back as `expected_due_hash` and gets 409 `stale_dues` if the family's dues changed in between (never a silent re-plan; `directed` rows are exact anyway). Idempotency keys belong to the user who sent them (another user's replay is `idempotency_conflict`); every payment writes an audit row with its receipt number. Dues shown to the family, in defaulters and in reminders are net of unallocated credit (floor 0).
M3a closing pass: **cash cannot be backdated** — cash is counted into today's drawer, so its business date is today, for everyone. Only non-cash receipts (bank, JazzCash, EasyPaisa, cheque, other) may be entered for yesterday, by an owner/admin, with a reason that is audited (`bad_business_date` otherwise). Refunds are dated today only and, when non-cash, name their account (`account_required`). Every payment, refund and reversal — any method — carries the number its series was bumped to in the same batch; cash ones need the drawer session (trigger `receipt_payment_shape`). The collection report counts cash on its drawer session's date (it always agrees with the cash close) and non-cash on its business date.

### 14.5 Monthly fees and defaulters (office)
- Generation runs on the 1st (cron) and from a button "Generate <month>"; idempotent; shows a dry-run count first; only active enrolments; applies live concessions and sponsorships as separate lines.
- Fine job runs after grace day: adds `fine` charges per overdue tuition charge (once per period), shows a list; office can waive per student with reason.
- Defaulters: by group, by months overdue, by amount; filters "exclude sponsored"; actions: "Remind all" (Send queue), export, print list for class teacher.
- Generation never sticks (M3a fix pass): a group whose chunk fails is logged as a failed `billing_chunk` (status `failed`, `error_code`), skipped for the rest of the tick (and by "Generate", which returns `failed` and moves on), and retried by the cron every tick; fines still run. `GET /api/fees/runs` lists it under `failing`. A group with a finished chunk is never re-sent; a student added to it later is billed with "re-generate" for that student.
- Re-open period (M4 fix pass): a group whose month finished with no fees billed (rates were missing) is listed on the billing screen; owner/admin "Re-open period" appends a `billing_chunk` row with status `reopened` (fresh cursor; the log stays append-only) and Generate bills it. The preview counts each (student, head, period) once across groups, so a student in a class and a batch is not counted twice (preview = commit).
- Due date: the school's due day; a mid-period joiner or transfer gets the same grace from their start (start + due day − 1 days). No late fine in the first period of an enrolment that started after the 1st. Pro-rata follows the enrolment chain (a mid-month transfer bills each row's days at its own rate, once). A student in a class and a batch is planned from both, primary first.
- Void (M3a fix pass): `POST /api/charges/:id/void` (fee.manage) zeroes a fee (or what is left of a fine) with a `reversal` line and a required reason; paid money is released first and becomes credit, which is applied to the payer's other dues. Charges are never deleted.
- Enums are final (last pass, migration 0010): receipt methods `cash, bank, jazzcash, easypaisa, cheque, other`; payslip status `draft → approved → paid`, or `void` before any payment.

### 14.6 Cash closing (collector, then owner)
1. End of day: session shows expected (receipts by method − expenses paid from this drawer), collector enters counted cash → variance → close.
2. Handover: "Transfer to owner / bank deposit" creates a `transfer` (never income or expense).
3. Owner sees all sessions, variances, and can reopen a session with reason.
Rules: a closed session takes no more rows; a late-found error is corrected in a new session with a reversal + re-entry.

M4 fix pass (drawers): cash leaves only the payer's **own** drawer (`drawer_account(by)`: the cash account they hold, else the shared one) and only into a session they opened — paying out (expense, salary, advance) or a handover never opens a drawer (409 `no_open_session`; opening an open drawer with another float is 409 `already_open`); a trigger refuses any cash movement whose account is not its session holder's drawer (`not_your_drawer`). Cash receipts store the drawer account at insert (migration 0016 backfilled older rows), so changing who holds a drawer never moves history, and a drawer's holder is frozen once money moved through it (409 `account_has_movements`; add a new drawer for a new holder). A drawer expense cannot be voided after its session closed (`session_closed`; correct with a new entry). Accounts carry a pre-pilot opening balance (owner, once, before any movement; Settings → Fees → Accounts) that balances and the cashbook start from.

### 14.7 Concessions and sponsorships (admin decides; keep it simple)
- One screen, one action: Student → Fees → "Reduce fee": reason (sibling / orphan / staff child / scholarship / topper / needy / other), % or fixed amount, which fee head (default: monthly tuition), from date, optional to date (blank = until ended), note. Whoever has the `admin`/`owner` role can do it; no proposal/approval workflow. Can be done at admission, mid-session, or for the next session; takes effect from the next generation, and the current month can be re-generated for that student.
- Ending or changing: "End" with date + reason; the row is never edited. A change = end + new row, so history stays auditable (e.g., 50% → 25%).
- No automation and no caps: toppers are a human decision; the admin simply adds a `topper` concession to the students they choose. (v2 may add a shortcut "add concession" button on the exam result list; nothing more.)
- Session boundary: concessions with no end date carry into the next session; the year-end promotion wizard lists them so the admin can confirm or end each in one pass.
- Sponsorship: sponsor record (name, phone, optional CNIC) → link to student with share % and dates → generation bills that share to the sponsor; sponsor statement shows what is owed/paid; sponsor payments go through the same Fee counter with payer=sponsor.
- Family view and parent page show gross, concession and net so parents see the discount they received; defaulter messages use the net.
- Which rows apply to a month (M3a fix pass): the concession or sponsorship **live on the period's first day** (for a student whose enrolment starts later in the month, on that first day). "End" is the first day it no longer applies; a change mid-month (end 15th + new row from 16th) therefore takes effect from the next month, and re-generating the current month uses the same rule. Concessions and fines are family lines only; a late concession on a sponsored month re-bills the sponsor on the new base (a `reversal` line under the sponsor root, then the family's concession line for the rest), releasing anything overpaid first. One sponsor may not have two overlapping sponsorships of the same student and head (409 `sponsorship_overlap`; end the old row first); if the data has them anyway, generation merges them into one sponsor line capped at 100%.

### 14.8 Expenses and salary (owner / accountant)
- Expense: date, category, amount, paid from (drawer or bank), vendor, note, optional photo of bill → `expense_no`; void with reason only.
- Salary: per staff, monthly payslip from base + allowances − deductions − advance recovery; "Approve" (owner) → "Pay" (amount, from account, date) → slip print/PDF. Advances: separate screen; outstanding shown on the payslip.
- Income vs expense report: by month; income by fee head; expenses by category; salaries line (earnings − deductions; tooltip says so in en/ur); transfers and advances excluded; "unallocated credit" shown separately.
- M4 fix pass: a payslip whose net is 0 (full recovery, or no lines) is `paid` on approval; an approved slip with part paid is shown "Partly paid" (`paid_partial`, status stays `approved`); recovery above the outstanding advance is refused when lines are written; suggested recovery = min(outstanding, 25% of the net after other deductions). Bill photos: replaced only before void, by whoever recorded the expense or an owner/admin; old photos are never deleted (each version is an audit row). Reads have no per-row query loops (`/api/payslips/mine` ≤ 4 queries, cash session lists 2).

### 14.9 Send queue (office / class teacher, phone)
1. Queue shows pending messages grouped by template: absence today, fee due, fee overdue, payment received, notice. Each shows guardian, phone, preview text in the guardian's language.
2. Tap → opens WhatsApp with the prefilled text (includes the parent link) → user sends → returns → the row flips to **sent**; "skip" with reason.
3. Bulk notice to a group: compose once (Urdu/English), queue per family, or copy text for the class announcement group.
4. Counters: pending / sent today / skipped; cooldown prevents re-queuing the same fee reminder within N days.
Rules: one message per family; staff without consent flag see "call instead"; everything logged in `message`. WhatsApp goes only to a mobile number (shared `isPkMobile`; SQL twin `PK_MOBILE_GLOB`): a landline-only or consent-less guardian is a `call` row at enqueue, and a WhatsApp row whose number is no longer a mobile becomes `call` at open. A WhatsApp row can be marked Sent only after it was opened. "Copy all texts" for a class group offers absence and notice texts only (fee texts are private). Notices are wrapped in the `notice` template's `{body}` slot; every template must keep `{link}` (and the notice `{body}`); `{was}` renders was/were (Urdu تھے).
**Absence rows (from M2) are prompts, not texts.** The register sync queues one `absence` row per family per day (`reminder_state` cooldown): `channel='wa_manual'` to the first guardian with WhatsApp consent and a number, else `channel='call'` (no consent, or consent but no number) so the office phones. Its payload records only the register that queued it. **M5 must rebuild each queued absence message from the current registers at send time**: skip it (status `skipped`) if none of the family's children is still absent — a later register or an office correction may have marked them present — and merge siblings absent in other groups the same day into one message. When marks + absentees in one sync request exceed 200 rows, the queue rows go in a second batch of the same request (never more than two); that batch is best-effort, the rebuild-at-send rule and the dashboard absentee list (computed from registers) cover a lost row. See `absenceStatements` in `apps/api/src/lib/attendance.ts`.

### 14.10 Parent page (guardian, phone, no login)
- Link format `https://<school>.conceptlix.com/p#<token>` (M5 fix pass): the token is a URL **fragment**, so it never reaches a server log, a path or a Referer; the page reads it and calls `GET /api/p`, `POST /api/p/gate`, `GET /api/p/receipt/:no` with the token in the `X-Parent-Token` header (the `public` grant sits on exactly those three). Shows children of this guardian: today's attendance, month attendance %, dues (net) with "how it's calculated", receipts (open/print), results (v2), notices. Urdu/English toggle (never saved: shared phones), "listen" button.
- Responses are whitelists: calling names (first name, or Muhammad + the next name when the name has three or more words), class, marks, dues lines, receipt numbers; no database ids (a child is an opaque per-link index, a receipt its number), no staff names, no CNIC/B-form/DOB/phones.
- Gate before dues/receipts/results; attendance and notices show without it. School default is the child's **birth year** (new schools and, by migration 0021, the existing one); links made automatically inherit it (never PIN). The birth year is a speed bump against a forwarded link, not a secret. Each attempt is claimed by one atomic `UPDATE … RETURNING` before it is checked: 5 in a sliding 15-minute window lock the gate for 15 minutes, a right answer resets the count; answers compare in constant time.
- Staff can regenerate or revoke a link from the guardian record; last-seen shown.

### 14.11 Dashboard and reports (owner)
- Today: collected by method, absentees, registers not taken, pending send-queue.
- Month: income vs expense, dues outstanding, defaulters count, new admissions, left.
- Reports (v1): fee register (per group per month), defaulter list, collection by collector, concession register, sponsor statement, attendance register (per group per month), expense register, salary register. All print-ready and CSV.

### 14.12 Settings and backup (owner)
- School profile, session, programmes/groups, fee rates (versioned), fine rule, concession rules (sibling auto-suggest), receipt series, templates (Urdu/English text with placeholders), custom fields, staff & roles, language/digits.
- Backup: "Download everything" (CSV zip + SQL); status of last nightly dump and Sheet export; "restore drill" checklist; recycle bin for reference data; audit log viewer.

## 15. Build plan (unattended mode, authorised 2026-10-10)

**Loop for every milestone** (no step skipped):
1. **Plan** — Fable writes the brief from §14 flows: scope, files, invariants, definition of done, tests required.
2. **Implement** — Opus agent builds it with tests; must pass typecheck, lint, tests, build before hand-back.
3. **Review** — a *separate* Opus agent reviews the diff blind (not shown the implementer's conclusions): correctness, permission scope on every route, money invariants, i18n/RTL, mobile layout; reports findings with severity.
4. **Verify** — Sonnet agent: clean clone → install → typecheck → lint → test → build → `wrangler dev --local` smoke with curl/screenshots; reports verbatim results.
5. **Fix loop** — findings go back to the implementer until review and verify are clean.
6. **Record & commit** — Fable records outcome here and in `docs/PLAN.md`, one commit per milestone (attribution line per session rules).
Stop and ask the user only for: GitHub publish, production deploy to `school.conceptlix.com`, anything with a cost, or a design change that contradicts the decision log.

**Standing rules learned in M0–M1**
- Every multi-statement write goes through `atomic()`/`tx()`; D1 behaviour is proven by `d1-atomic.test.ts` on workerd and by the per-milestone smoke script, never by better-sqlite3 alone.
- Per-request budget on the free tier (50 subrequests, 10 ms CPU, 100 bound params): bulk work is ≤ 200 rows per request via `json_each`, with a client-side loop; never loop batches inside one request.
- **Schema enums:** adding a value to a CHECK column forces a full table rebuild, which fails under D1's always-on foreign keys once rows exist (seen in migration 0004). Finalise status enums on data-bearing tables (`enrolment`, `charge`, `receipt`, `payslip`, `message`) before the pilot; afterwards, new states go in lookup tables, not CHECK edits.
- Migrations are forward-only from `8a530c7`; custom SQL changes emit a new numbered migration via the sync script with its manifest.
- Tap targets 44 px on touch (coarse pointer); desktop (fine pointer) may use 36 px controls (amended 2026-10-13 for M7b); verifiers measure with touch emulation. Data-derived names in mixed-direction text are wrapped in `<bdi>`.
- Exports use the formula-safe CSV writer in `@maktab/shared`.
- D1 allows at most 5 terms in one `UNION`; nest unions in views (seen in migration 0015).
- Numbers are `<series>-<year>-<n>` with n zero-padded to **at least** 5 digits (100000 follows 99999); `ledger_consistency` accepts that.
- Thermal receipts: while the 58 mm receipt is on screen the whole document prints on the `receipt-thermal` named page (`html, body { page: receipt-thermal }`): any box left on the default page — the app shell, the toaster's empty section — forces a page-type switch and a blank Letter/A4 second page. Check with `node apps/web/scripts/print-pages.mjs <url> --expect 1` (CDP `printToPDF`).
- Offline behaviour is tested with `navigator.onLine=false` + the `offline` event; money UI attempts carry one idempotency key per attempt, independent of any view hash, kept until a definite outcome.

**M3 must remember (from the M1 review)**
- Admission has two write paths (new student, re-admission); fee charges must be added to both inside the same batch.
- Transfers now end the old enrolment with status `transferred` (not `withdrawn`); generation must treat only `withdrawn`/`completed` as leaving.
- Imported enrolments may start years ago: never backfill charges from `start_date`; use `opening_balance` for carry-in.
- Receipt numbering uses the same in-batch series bump as `admission_series`; `school.receipt_prefix` exists.
- A reversal and its unwind allocations are one batch via `reverseReceipt`; `ledger_consistency` must stay empty in every test.
- Leave date is not validated against enrolment start; pro-rating must clamp.

**M3b must remember (from the M3a fix pass)**
- Error codes the UI must handle: `bad_business_date` (400; yesterday needs owner/admin + `backdate_reason`, and never for cash), `stale_dues` (409; re-fetch the family view and re-confirm), `idempotency_conflict` (409; mint a new key), `account_required` (400; non-cash with no bank/wallet account), `sponsorship_overlap` (409), `already_void` / `not_voidable` (409), `session_closed`, `reason_repeated` (reopen reasons compare case- and blank-insensitively), and a `failed` object in the generate response (show it; `next` already skips the group).
- Hash field: family view (and sponsor statement) `dues_hash`; send it as `expected_due_hash` on `POST /api/receipts` for an oldest-first collection (ignored with `directed`). `totals.due`/`overdue` are net of credit; `totals.due_before_credit` is the raw sum.
- Date rules: the counter's date picker offers today, and yesterday only to owner/admin for a non-cash method (with a reason field); refunds are today only; drawer sessions are today's only; liveness of concessions/sponsorships is "live on the period's first day"; a joiner's due date is start + (due day − 1) only when the enrolment chain starts in the period (a mid-month transfer keeps the normal due date).

**M3b must remember (from the M3a closing pass)**
- Billing alerts: dashboard `billing_alerts` > 0 → banner linking to the generation screen; `GET /api/fees/runs` `failing[]` carries `fail_streak`, `retry_after`, `attention_required`. The cron backs a failing group off (2^n ticks, ≤ 24 h); "Generate" retries immediately.
- Void (`POST /api/charges/:id/void`) on a fee voids the whole unit (family + sponsor roots); the response lists `voided[]`. Show both lines in the confirm dialog.
- Fines: the cron (and `POST /api/fees/fines/apply` without `period`) fines every overdue tuition root of any period, filed under the root's period.
- Sponsorships: one row per (sponsor, student, head|all) at a time, enforced by the DB; the planner bills a sponsor's latest-starting live row.
- Methods `cheque` and `other` exist (labels in en/ur needed); payslip `void` (M4 UI).
- Run `npm run db:verify -- --remote --env gsap` after every `migrations apply` (docs/deploy.md).

**M6 must remember (from M5)**
- Backups and "download everything" include `message_template` (staff-edited texts), `parent_link` (hashes only) and `message` (texts with a `{link}` stub, never a live link); restoring needs the same `PARENT_LINK_SECRET` (docs/restore.md), else run "Revoke all parent links" (`POST /api/parent-links/rotate-all`, owner) after the restore.
- Alarm on message failures: rows stuck `queued` for days, `failed` rows (wa_api later), parent-link gate lockouts; the nightly job can count them.
- Templates editor and message settings live in Settings → Messages (M5); M6's settings work should not duplicate them.

**M7 must remember (from M5)**
- Turnstile on the parent routes (`/api/p/gate` first) and a Cloudflare rate-limiting rule on `/api/p*`; the in-isolate limiter (60/min per token) is best effort only; the gate lockout itself is atomic in D1.
- `/p` and `/p/*` are in `run_worker_first`; the Worker copies the SPA headers (CSP, Permissions-Policy, nosniff, frame) into that response — keep `SPA_HEADERS` in `apps/api/src/app.ts` in step with `apps/web/public/_headers`.

**M7 must remember (from M6)**
- The nightly job reports to `POST /api/backup/runs` with `BACKUP_REPORT_TOKEN`; rotating that secret means both the Worker secret and the GitHub secret (docs/backup.md §3). The route is a token-only `publicRoute` (permission snapshot row `D D D D D A`).
- "Download everything" reads every table except `user_session` and `parent_link_access`; `parent_link.token_salt` is never exported (EXPORT_REDACTED_COLUMNS in `@maktab/shared`). A new secret-bearing column must be added there in the same change.
- The daily pass (`runDailyOps`) runs on the */30 cron after 03:00 PKT; it is one read per tick otherwise. Alarm thresholds live in `ALARM_RULES` (`@maktab/shared`). `failed` messages only appear once wa_api/sms adapters exist.
- Archived groups (`grp.archived_at`) are hidden from `GET /api/groups` unless `?archived=1`; any new group picker or report that lists groups should do the same.
- The restore drill needs the private key in GitHub (environment secret, protected). If the owner prefers it never leaves the trustees, run docs/restore.md section B by hand instead and record the drill in Settings → Backup.
- Turnstile / WAF on `/api/backup/runs` is not needed (token), but a Cloudflare rate-limit rule covering `/api/*` POSTs would also cover it.

| Milestone | Scope (from §14) | Done when |
|---|---|---|
| M0 Scaffold | Workspaces, schema + triggers, auth + permission matrix + tests, bilingual PWA shell, outbox module, CI, backup workflow, docs | **Done 2026-10-10** (`8a530c7`); carried forward to M7: 547 KB web chunk (code-split / zod-mini), README "Checks" line to mention the custom-SQL check |
| M1 Foundation | Setup wizard (14.1), staff invites/roles, families/guardians/students CRUD + admission flow + enrolment (14.2), programmes/groups/sessions, CSV import, audit log writes | **Done 2026-10-10** (`82e96cf`; 243 tests; smoke `smoke:m1` green; teacher scope verified over HTTP; 360 px screens verified in en/ur). Found and fixed on the way: Drizzle D1 `batch()` could not bind params for raw SQL (M0 bug, now covered by `d1-atomic.test.ts` on workerd); CSV import hash included a defaulted date; import commit capped at 200 rows/request with a client loop. Carried to later: capacity is a planning number (not enforced); R2 orphan cleanup is best-effort; web bundle splitting (M7) |
| M2 Attendance | Register screen (14.3), offline outbox wired, corrections with reason, "registers not taken", absentee list feeding the message outbox | **Done 2026-10-10** (`51144f0`; 290 tests; smokes m1+m2 green; true-offline save → sync, offline reload, failed-entry UX, 150-mark register, clock-skew clamp, two-phone races all verified on workerd/CDP). Review caught a Critical (Save paused by react-query's online mode) that unit tests missed — rule: offline behaviour is tested with `navigator.onLine=false` + the `offline` event, never a throwing fetch alone. Carried: 20 px link on student detail; sign-out while offline should queue session revocation (M7); CONTRIBUTING needs the offline-reload manual check (build + `vite preview`, SW target offline too) |
| M3 Fees | Fee heads/rates, monthly generation (cron + button), fee counter family view, receipts (series, print HTML), allocations, reversals, concessions, sponsorships, late fines + waivers, defaulters, cash sessions, transfers (14.4–14.7) | **M3a backend done 2026-10-10** (`075b6d1`; 372 tests; 73 triggers; smokes m1–m3; 10 parallel collections contiguous on D1; migration-with-data verified). Two blind reviews + three verifies found and fixed: cron starvation by failing groups (now ordered last, exponential backoff, `attention_required` after 3 failures), sponsorship overlap (DB trigger + latest-row planner), backdating (cash never; non-cash yesterday for owner/admin with reason), liveness on the period's first day, joiner due date/fine exemption, pro-rata across transfer chains, credit re-applied after waiver/regenerate, dues net of credit, whole-unit void, receipt shape rules for refunds/reversals, fines across periods, `db:verify` after every migration. Rules: opening credit is a `receipt.kind='opening'` tied to its `opening_balance` row; sponsor share = % after concessions, billed to the sponsor, never fined, never makes a family a defaulter. **M3b screens done 2026-10-10** (`c15600d`; 556 tests; smokes m1–m3b; browser-verified: lost-response retry yields exactly one receipt, attempt survives reload, replays on reconnect; stale-dues; thermal 57.8 mm Urdu PDF; waiver, refund, route guards). Review fixed: idempotency key no longer tied to `dues_hash`; choose-lines with nothing ticked; confirm dialog shows rows/account/date; share is text-only; generate route ran the generator twice and reported the empty run; fine waiver + refund + "Bill now" (unbilled) UIs added. Carried to M4 pass: concession-register link height, blank 2nd page on thermal PDF, preview over-counts dual-enrolled students the commit skips, "re-open period" when rates are added after a month is done |
| M4 Money out & reports | Expenses, payslips/advances/salary payments (14.8), income vs expense, dashboard (14.11), report pack (print + CSV) | **Done 2026-10-10** (`8b7ad4e`; 724 tests, 3 runs no flake; 89 triggers, 8 views; smokes m1–m4). Reviewer's hand-worked month is a permanent test (`pl-month.test.ts`) plus 23 adversarial cases; P&L excludes opening receipts, transfers and advances; cashbook ties to balances by construction (`money_movement`). Review fixed: owner pay leaking to accountants via aggregates (now "Salaries (excluding management)", `owner_draw` masking, `{ties}` only), per-row read loops vs the 50-query budget, cash-out locked to the payer's own drawer, drawer account stored on receipts, account opening balances, bill-photo evidence never deleted, void-after-close refused, no silent drawer auto-open. **Pause point: published to github.com/faysalmehmood/maktab.** Carried to M5/M7: A5 receipt prints 2 pages in en; docs: vite needs `PORT`/`API_PORT`, an owner needs a second owner/admin to approve their own slip |
| M5 Messaging | Outbox table, templates en/ur, send-queue UI (14.9), parent magic-link page with listen button (14.10), cooldowns, consent handling | **Done 2026-10-13** (`e470a42` + seed fix; 796 tests; smokes m1–m5; live in production with migrations 0019–0021, `PARENT_LINK_SECRET`, privacy headers verified on maktab.conceptlix.com; clean-clone re-verify green). Absence rows rebuilt from current registers at open (skip `no_longer_absent`, siblings merged), fee reminders re-checked (skip `already_paid`), explicit Sent, link alone on the last line; notices in 200-family batches; parent page with gate, access log, listen. Gaps: parent receipt view has no logo (logo route needs a session); `parentReceiptLink` on staff receipts still null. **Fix pass 2026-10-11** (blind review + browser verify): no live link at rest (`{link}` stub in rows/lists, live only in `/open`), atomic gate claim (20 parallel wrong answers on workerd → ≤ 5 counted), `PARENT_LINK_SECRET` (+ `rotate-all`), fragment links `/p#<token>` + `X-Parent-Token`, birth-year default gate, notices wrapped in the `notice` template's `{body}` (every template keeps `{link}`), landlines → call at enqueue and open, whitelisted parent DTOs (child index, receipt number), bounded counters, bulk text absence/notice only, Sent needs Open for WhatsApp rows, `{was}` was/were, parent language not persisted, `has_parent_link` on guardian delete. Carried to M7: Cloudflare WAF rate-limit on `/p*`, Turnstile on the gate, parent receipt logo, `parentReceiptLink`, access-log retention |
| M6 Settings & backup | Templates, custom fields, recycle bin, audit viewer, "download everything", nightly backup live to R2 + B2, Sheet export (14.12) | **Done 2026-10-13** (`06097cb`; 848 tests, 5 identical runs; smokes m1–m6; live in production with migrations 0022–0023, `BACKUPS` binding, `BACKUP_REPORT_TOKEN`; 97 triggers). Owner "download everything" (client-driven ZIP, one CSV per table, formula-safe, bilingual README), backup status page, alarms (`ledger_consistency`, stuck/failed messages, gate lockouts, billing attention, **backup_stale**), recycle bin with DB triggers against archived groups, retention, About page. Review fixed: stale-backup alarm + monthly keep-alive commit (GitHub disables idle schedules after 60 days), upload-then-flag on shrink, archived-group guards, archive race, deduplicated failure issues, a real ordering bug (same-millisecond billing chunks tie-broken randomly). **Deferred by user decision until real data: Cloudflare API token → first nightly run → restore drill** (steps in docs/deploy-log.md; `BACKUP_ENABLED=false` meanwhile) — now a pre-pilot gate in M7 |
| M7a Hardening (code) | Permission audit, Turnstile + rate limits, Urdu translation pass, PWA polish, Android device checks (exp 3/4/6 phone halves), deploy to `school.conceptlix.com` (ask first), onboarding guide | **Done 2026-10-13** (`4fcf7c1`; 922 tests; smokes m1–m7; live in production). Permission audit (every route × role incl. write sweeps, no leak), Turnstile (sign-in fails open, gate fails closed), per-IP limiter + exact WAF expressions, queued sign-out bound to the old session (review caught it could revoke the next user's), per-user outbox + sign-out warning, `/p` excluded from the SW fallback, A5 receipt 1 page ≤ 8 lines (12-line receipts spill: M7b receipt pass adds a page-2 footer), parent receipt logo, `parentReceiptLink`, Urdu complete (1588 keys, CI-checked), first-load 183 KB gzip with a CI budget, Dependabot fixed, onboarding/pilot/android docs, `/diag`. Human steps for M7c listed in docs/pilot-checklist.md |
| M7b UI/UX polish & branding | Phases 0–7 of `docs/ui-enhancement-plan.md` §9 under the §15 loop, on a branch: tokens/status colours/dark mode, grouped shell + bottom bar, shared components, school branding (badge, colour, placements incl. parent page + receipts), sign-in + five-step setup, screens (Home, Students, Profile, Attendance, Fees, Messages, then the rest), mark redraw; plus the additions in the 2026-10-13 decision | **Part 1 done 2026-10-13** (`c9d03b7` merged + live: migration 0024 school identity; 990 tests; tokens/dark mode/density, grouped shell + bottom bar, generated badge + branding on sign-in/parent page/prints, five-step setup, role homes with Needs attention, shared parts DataTable/FilterBar/Avatar/RowMenu/Tabs/StatStrip). Review fixed: dark destructive contrast, false all-clear while loading, payslip 2-page print, save bar hidden under the phone tab bar (`--tabbar-h`). **Part 2 done 2026-10-13** (`24c19b1` merged + live; 1,069 tests; all ten screens rebuilt on the shared parts, four weak ones rebuilt again after review; focus mode for messages; first-week checklist; two Urdu bidi bugs fixed (`<bdi>` forced LTR, dates); `MonthInput`; audit labels complete with a test; **`apps/web/scripts/sweep-360.mjs`** now a standing check: 272 page loads at 360/390 × en/ur × light/dark, 0 overflow, min target 44). First load 194 KB of 200. **M7b closed.** Deferred: profile header "Message"/"Change photo"; Billing one-click re-open/fines (no confirm, by choice) |
| M7c Pilot gate | API token → first nightly run → restore drill (`BACKUP_ENABLED=true`), B2 secrets, key escrow confirmed, WAF rate-limit rules + Turnstile keys, R2 lifecycle rule, Android device checks (`docs/android-checks.md`), owner + admin invited, fee heads/rates + templates reviewed with GSA | `docs/pilot-checklist.md` all ticked; GSA enters its first real month |
| 2026-10-14 Chrome walkthrough of the demo | Product owner walked every demo screen in Chrome; findings A–K fixed on branch `walkthrough` (1,142 → 1,183 tests); blind review fixed: the wipe drops children first (a reseed over the demo was ~41k writes, now ≤ ~31.4k on every seed day to 2028-04-30, with the school trimmed to 112 students), a missed Monday/1st reseed retries later that day, seed day ops idempotent on re-run, 2026–28 holidays, safe date formatting, `telHref` | **A** demo dated from the seed day (`DemoCalendar`, `_demo_state.anchor`): six months ending with the current month billed and partly collected, 5 cash receipts in today's open drawer, 12 of 19 registers today, today's absences queued, payslips through last month, sponsors owing; full reseed at 02:00 PKT on Mondays and the 1st (~32,200 writes) instead of the undo (`apps/api/src/routes/demo.ts`, docs/demo.md). **B** real "Page not found" for unknown URLs (Placeholder removed). **C** one shared not-found state on every detail page; 404s no longer retried. **D** students list/search show programme + group (`programme_name` in the list DTO, `classLabel`). **E** DateText/month names everywhere ISO leaked (student detail, audit log in Asia/Karachi time, payslips, statement, cashbook and ~20 more). **F** account menu widened so the Theme options fit (en + ur). **G** `formatPkPhone` formats typed landlines (`042 3555 0100`) on sign-in and print headers. **H** the parent page keeps the §7 privacy rule but shows the calling name: the first word, or Muhammad (any spelling, also محمد) + the next name for names of three or more words (`firstName` in `@maktab/shared`, also the staff greeting). **I** advances "Outstanding" lists only staff who still owe, with an empty state. **J** sponsor row figure labelled "Due" (muted at zero); the seed gives sponsors real dues. **K** month comparison shows "—" when either month is zero |
| 2026-10-15: demo read budget | `wrangler d1 info` showed ~11M rows read a day (limit 5M, account-wide, shared with the GSA pilot): D1 bills every row a query visits, including scans inside views, triggers and `sqlite_master`, and nobody had measured reads. Measure on workerd's D1, cut the reseed's reads, recognise the read-limit error, on branch `demo-reads` | **Done** (1,188 tests). `apps/api/test/d1-demo-reads.test.ts` is a standing check: a counting wrapper around the D1 binding sums `meta.rows_read` per step and per statement over a full reseed driven as the cron drives it. Reseed over the demo 1,236,530 → **345,425** rows read (`DEMO_SEED_READS` 400,000, target 1M, cap 1.5M); 02:00 tick with nothing to undo 502 → 35; small nightly undo 22,836 → 6,009; idle tick 23, `GET /api/demo` 11. Causes: dropping the self-referencing `charge` deleted row by row with a full scan per row for children (n²/2, 563k rows), so the wipe now keeps the self-FK index until the drop; the undo looked in `sqlite_master` (~470 rows) to see whether its log exists and dropped every trigger of a touched table (each DROP scans `sqlite_master`), now it reads the log directly and drops only the triggers its restores fire; migration 0025 indexes `receipt(cash_session_id)` and `payslip_line(payslip_id)` (full scans per drawer close and per payslip read, also in production); the generation cursor joins in JS (groups × chunks rows); credit lookups bind `IN (?, …)` so SQLite reads `payer_credit` by index. Quota guard: the "daily row read limit" wording recognised (not a bare code 7500, which is also D1's transient internal error); the isolate remembers the backoff so ticks touch nothing until 00:00 UTC; step and status routes answer 503. Rule: **any new demo step, view or trigger is measured with the reads harness, not only the write estimate** |
| 2026-10-17: demo resume idempotency (found in production) | The public demo's reseed of 2026-10-15/17 ended with 100 messages (absence 31 + notice 69) and no fee reminders or payment messages. The runner saves the cursor (`step`, `sub`) only when a step ends or an invocation does, so an invocation cut (CPU limit, cron removed) after `messages` sub 0 or 1 had committed re-ran the step from sub 0, whose check "any message exists" returned done. On branch `demo-resume-idempotent` | **Done** (1,194 tests). Every sub-step now checks its own rows: `messages` writes only the message ids (and `reminder_state` keys) of its own templates not yet there; `parent-links` only the link ids missing; concessions (one batch each, so a cut inside sub 0 left some) only the missing ids; sponsors checked by id; a reversal with a re-entry applies the family's credit again when the reversal is already there (a cut between the two). Tests: messages cut after sub 0, 1 and 2 then resumed from sub 0, parent links re-run, concessions cut after 3 of 12, and every step of a reset "cut" after each sub-step and resumed from sub 0, all equal to an uninterrupted seed (fingerprint now also covers message ids, `reminder_state`, parent links, concessions). Writes unchanged (29,505 over the demo on workerd; local seed ~31,346); reads 348,328 → 348,658. Rule: **a sub-step's "already done?" check looks for that sub-step's own rows, never for any row in the table** |

**After M7 — direction, not scope yet (user, 2026-10-13):** Maktab should run (a) on Cloudflare's free tier, (b) on-prem on a homelab or any server, (c) hosted for another entity that wants its own copy, and (d) possibly as a subscription-hosted service for some schools; it must stay shippable, customisable and secure. The architecture already allows this (SQLite + Drizzle + Hono, one school per installation, AGPL permits hosted services). Candidate **M8 "Platform & portability"**: Docker image with SQLite-on-disk + local file storage exercised in CI (the §8 escape hatch), `docs/self-host.md`, a "Deploy to Cloudflare" path for a school's own account with a front-door Worker on `<school>.conceptlix.com` (see the 2026-10-13 note on per-school accounts and the R2 card requirement), release versioning and signed images, per-installation configuration surface, and a hosted-service runbook. To be planned after M7c.

## 16. Research summary (2026-10-10)

| Study | Verdict |
|---|---|
| OSS survey (Gibbon, RosarioSIS, Frappe Education, OpenEduCat, openSIS, Unifiedtransform, Fedena, SchoolTool, Evershine, CoachSync, qtec, academico, skuul, OpenMasjidStudents, flowclass, safina-showcase) | No fork candidate. Borrow: Frappe group, Rosario dated enrolment, Gibbon family + messenger, OMS ledger, CoachSync reversals/cash snapshot, academico numbered series, Evershine penalty lifecycle/maker-checker |
| Evershine code audit (130k lines, 92 models) | Ideas only. Payment race, hard-deleted invoices, no receipt numbers, unauthenticated seed/debug/migration routes, permission UI not enforced, no Urdu/WhatsApp/backup; MySQL + interactive transactions → not portable to D1 |
| Fee-ledger study | OMS strongest (integer cents, derived balances, reversal rows, family billing, idempotent generation). qtec is the anti-pattern (mutable totals, deletable payments, no LICENSE file) |
| Academic-model study | Unified group/enrolment model (§4). Gibbon `ur_PK` ~58% translated, Arabic font not Nastaliq — glossary only |
| Storage study | Sheets API: 300 req/min/project, no transactions, concurrent append loss reports; wrappers 200–500 req/month; AppSheet $5+/user. D1: batch = transaction, FK enforced, 7-day Time Travel. No free offline sync engine fits D1 → hand-made outbox |
| Hosting study | Supabase pauses after 7 days idle; Render free Postgres deleted after 30 days; Fly/PlanetScale/Xata no free tier; AWS free plan ends at 6 months; Oracle reclaims idle VMs. Cloudflare is the only "nothing expires" stack |
| Notifications study | Meta Pakistan rate card 1 Oct 2026: utility/auth $0.015, marketing $0.0473, service $0.015 after 1,000 free/month; unverified portfolio 250 recipients/day; SMS semi-branded Rs 4.00–4.10; Twilio SMS to PK $0.47 (unusable); broadcast lists no longer reliably free |

Key sources: developers.cloudflare.com (workers/platform/limits, d1/platform/limits, d1/worker-api/d1-database, d1/reference/time-travel, d1/best-practices/import-export-data, r2/pricing), developers.facebook.com/documentation/business-messaging/whatsapp/{pricing,messaging-limits,templates/supported-languages,getting-opt-in}, developers.google.com/workspace/sheets/api/limits, sendpk.com/price.php, github.com/OpenMasjid-Solutions/OpenMasjidStudents, github.com/rakibul-islam-raju/CoachSync, github.com/chaudhayabdullah786/evershine_lms.
