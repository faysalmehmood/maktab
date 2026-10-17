# Screenshots

Screens covered (English and Urdu/RTL, phone and desktop):

- Sign-in
- Dashboard
- Students list and admission form
- Student profile (guardians, fees summary)
- Attendance: daily register (including offline state and sync outbox)
- Fees: charge batches, collect payment, receipt
- Family ledger and dues
- Money-out: expenses and payslips
- Reports (collections, dues, attendance)
- Language toggle (English / اردو)

Files are in `docs/design/m7b-1/` and `docs/design/m7b-2/`, listed below by screen with their
`<device>-<lang>-<theme>` variants. The onboarding guide still needs its own captures (table at the end).

### `docs/design/m7b-1/`

- `gsa-expenses`: desktop-en-light, phone-en-dark
- `gsa-home`: desktop-en-dark, desktop-en-light, desktop-ur-light, phone-en-light, phone-ur-dark
- `gsa-more`: phone-en-light
- `gsa-receipt-a5`: desktop-en-light
- `gsa-search`: desktop-en-light
- `gsa-settings-tabs`: desktop-en-light
- `gsa-setup-1-school`: desktop-ur-dark
- `gsa-setup-2-classes`: desktop-ur-dark
- `gsa-setup-3-fees`: desktop-ur-dark
- `gsa-setup-4-staff`: desktop-ur-dark
- `gsa-setup-5-done`: desktop-ur-dark
- `gsa-setup-5-done-no-groups`: desktop-ur-dark
- `gsa-setup`: desktop-en-light, phone-ur-light
- `gsa-signin`: desktop-en-light, phone-ur-dark
- `gsa-students`: desktop-en-light, phone-ur-light
- `gsa-teacher-home`: phone-en-light
- `noor-home`: desktop-ur-light, phone-en-light
- `noor-setup`: desktop-en-dark
- `noor-signin`: desktop-en-light, phone-en-dark

### `docs/design/m7b-2/`

- `attendance-register`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `attendance-teacher-today`: phone-en-light, phone-ur-dark
- `attendance-today`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `audit-log`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `classes-detail`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `classes-list`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `classes-teacher-mygroups`: phone-en-light, phone-ur-dark
- `fees-billing`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `fees-cash`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `fees-concessions`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `fees-counter-confirm`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `fees-counter`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `fees-defaulters`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `fees-more`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `fees-receipt`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `fees-register-choose`: desktop-ur-dark, phone-en-light
- `fees-register`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `fees-sponsors`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `home-owner`: desktop-en-light, desktop-ur-dark, phone-en-dark, phone-ur-light
- `messages-compose`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `messages-focus`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `messages-list`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `money-advances`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `money-expenses`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `money-payslip`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `money-salary`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `parent-page`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `reports-cashbook`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `reports-hub`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `reports-income-expense`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `settings-about`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `settings-backup`: desktop-en-light, phone-ur-dark
- `settings`: desktop-en-dark, desktop-ur-light, phone-en-light, phone-ur-dark
- `settings-recycle-bin`: desktop-ur-dark, phone-en-light
- `student-profile`: desktop-en-dark, desktop-en-light, desktop-ur-dark, desktop-ur-light, phone-en-dark, phone-en-light, phone-ur-dark, phone-ur-light
- `student-profile-messages`: desktop-ur-dark, phone-en-light

## M7b part 1 (captured): `docs/design/m7b-1/`

Captured from a local `wrangler dev` with smoke data (demo names only), GSA identity (badge `GSA`,
Pakpattan) and Al-Noor (uploaded logo). They need migration **0024_m7b_school_identity**
(`school.short_name`, `city`, `brand_color`; nullable columns, no rebuild) applied to the local D1
(`npm run db:migrate:local`) before the identity fields show. Name pattern:
`<school>-<screen>-<phone|desktop>-<en|ur>-<light|dark>.png`.

- Sign-in, home (owner, teacher), More sheet, search, A5 receipt (earlier captures).
- Setup in Urdu, dark: `gsa-setup-1-school`, `-2-classes` (groups part), `-3-fees`, `-4-staff`,
  `-5-done`, and `-5-done-no-groups` (the `no_groups` guard: "make at least one group first").
- Shared parts: `gsa-students-*` (DataTable + FilterBar; phone cards with the Filters sheet),
  `gsa-expenses-*` (DataTable with the bill action in the row and Void in the RowMenu),
  `gsa-settings-tabs-*` (Tabs).
- Payslip print proof (not an image): `node apps/web/scripts/print-pages.mjs
  "<origin>/payslips/<id>/print?lang=en|ur" --expect 1 --wait-for '[data-lang]' --cookie <dev session>`
  gives `pages=1 sizes=420×595` (A5) in both languages.

## M7b part 2 (captured): `docs/design/m7b-2/`

Same local setup as part 1 (smoke data, demo names only). Name pattern:
`<area>-<screen>-<phone|desktop>-<en|ur>-<light|dark>.png`; phone 390 px at 2×, desktop 1366 px;
PNGs palette-quantised. Primary screens have all 8 variants, secondary screens 4 (each axis
covered). Fix pass: the rebuilt Fee register (`fees-register-*`, plus `fees-register-choose-*` for
the "choose a class" state), Concessions, Advances and Billing in all 8 variants; Sponsors and
Expenses re-shot in 4; the Urdu receipt result (`fees-receipt-*-ur-*`) re-shot after the date fix.

## To capture (onboarding guide)

Referenced from `docs/onboarding.md` by id. None captured yet. Use demo data only (seed), never a
real family. Phone = 360 px wide (Chrome device mode or a real Android); laptop = 1280 px.

| Id | Screen / route | Lang | Width | Must be visible |
|---|---|---|---|---|
| onb-01-signin | `/login` | en | 360 px | "Sign in with Google", language switch |
| onb-02-wizard-school | `/setup`, step School | en | laptop | name, Urdu name, logo upload, receipt prefix, step counter |
| onb-03-wizard-classes | `/setup`, step Classes | en | laptop | "Add Pakistani classes and subjects" result with the class list |
| onb-04-settings-fees | `/settings?section=fees` | en | laptop | fee heads, a rate per class with "From date", late-fine rule, accounts |
| onb-05-staff-invite | `/settings?section=staff` | en | laptop | invite form (Google email, role) and a staff list with all four roles |
| onb-06-admission-family | `/students/new`, family step | ur | 360 px | phone search with "Is this a sibling of …?" match |
| onb-07-admission-student | `/students/new`, guardian + student | en | 360 px | WhatsApp consent tick box, photo button, class picker |
| onb-08-import-check | `/students/import` after "Check file" | en | laptop | per-row Will add / Skip / Error and the summary line |
| onb-09-billing-preview | `/fees/billing` | en | laptop | Preview counts, Generate button, late fines block |
| onb-10-counter-family | `/fees/counter` with a family open | ur | 360 px | children's dues, total, amount + method, English digits in Urdu UI |
| onb-11-receipt-58mm | `/receipts/:id?fmt=thermal` | ur | 360 px | 58 mm paper chosen, Print, Share, Send payment-received |
| onb-12-receipt-a5-ur | `/receipts/:id` (A5, Urdu) print preview | ur | laptop | whole receipt on one A5 page, Nastaliq text, logo |
| onb-13-attendance-today | `/attendance` | en | 360 px | today's groups with "Not taken" badge |
| onb-14-register | `/attendance/register/:grpId` | ur | 360 px | students with P/A/Lt/Lv marks, Save attendance |
| onb-15-register-offline | register after saving offline | en | 360 px | "You are offline", "Saved on this phone…", waiting-to-sync count |
| onb-16-send-queue | `/messages` | ur | 360 px | grouped rows, Urdu preview, Open WhatsApp, Sent & next, a "call instead" row |
| onb-17-compose-notice | `/messages/compose` | en | laptop | audience choice, en + ur bodies, previews |
| onb-18-parent-link-panel | `/students/:id`, Parent page link | en | laptop | status, check choice, Create link / New link / Revoke, Recent visits |
| onb-19-parent-page-ur | `/p#<demo token>` after the check | ur | 360 px | attendance, dues, receipts, Listen button |
| onb-20-parent-gate | `/p#<demo token>` before the check | ur | 360 px | birth-year question and Open button |
| onb-21-cash-close | `/cash` | en | 360 px | Expected, Counted cash, Variance, Close drawer, Handover / bank deposit |
| onb-22-defaulters | `/fees/defaulters` | en | laptop | filters, Remind all, Print list |
| onb-23-reports-hub | `/reports` | en | laptop | list of reports |
| onb-24-payslip | `/salary/:id` | en | laptop | lines, Approve, Pay, Print slip |
| onb-25-settings-backup | `/settings?section=backup` | en | laptop | nightly status, Download everything, restore drill checklist, alarms |

### `docs/design/guide/` (Help & guide)

- `guide-home`: desktop-en-light, desktop-ur-dark, phone-en-dark, phone-ur-light (owner)
- `guide-home-teacher`: phone-en-light, phone-ur-dark (the teacher's trimmed list)
- `guide-task-collect-fee`: desktop-en-light, desktop-ur-dark, phone-en-dark, phone-ur-light
- `help-sheet-counter`: desktop-en-light, phone-ur-dark (the "?" on the fee counter)
- `tour-register-step3`: phone-ur-dark; `tour-register-step4`: desktop-en-dark;
  `tour-register-step5`: phone-en-light (card above the sticky save bar)
- `tour-counter-step4`: desktop-en-light, desktop-ur-dark, phone-ur-light
- `home-first-week`: desktop-en-light (each open step links to its guide step)
