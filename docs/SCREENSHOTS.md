# Screenshots

Placeholder: no images yet. Planned screens (English and Urdu/RTL, phone and desktop):

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
| onb-14-register | `/attendance/register/:grpId` | ur | 360 px | students with P/A/L/E marks, Save attendance |
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
