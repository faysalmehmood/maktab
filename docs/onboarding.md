# Maktab onboarding guide / مکتب: شروع کرنے کی رہنمائی

For the school owner and the office clerk. Read it once, then keep it open during your first month.
Button names below are the English labels in the app; the Urdu screen has the same buttons in the
same places.

Before you start:

- Use Chrome. Setup and reports are easier on a laptop; attendance, the fee counter and the send
  queue are made for a phone.
- **Numbers are always in English digits (0–9)**, also on the Urdu screen and on Urdu receipts.
  Dates are Gregorian. This is on purpose; it is not a bug.
- Money is never deleted. A mistake is corrected with a new entry (a reversal, a void with a
  reason). Every change is kept in the audit log.

---

## 1. First sign-in / پہلی بار سائن اِن

پہلی بار مالک اپنے گوگل ای میل سے سائن اِن کرتا ہے۔

1. Open the school's Maktab address (for the pilot: https://maktab.conceptlix.com).
2. Tap **Sign in with Google** and choose the owner's Google account. This must be the owner email
   the maintainer set on the server. The first person to sign in with it becomes the **Owner**.
3. Everyone else can sign in only after the owner invites their Google email (section 3). Anyone
   else sees "Only staff invited by the school can sign in."
4. The language switch (English / اردو) is in the top bar. Each person can choose their own.

Screenshot: onb-01-signin

## 2. Setup wizard / اسکول کی ترتیب

چند قدم: اسکول، قسم، سیشن، کلاسیں، گروپ، فیس، عملہ۔

After the first sign-in Maktab opens **School setup**. Steps:

1. **School**: school name, name in Urdu, address, phone, default language, receipt prefix (letters
   before receipt numbers, e.g. `ANS`). Press **Next** once to save; the step then shows the **logo**
   upload (PNG, JPEG or WebP, up to 512 KB). Press **Next** again to go on.
2. **Type**: School (classes with sections), Academy (batches and courses) or Both.
3. **Session**: the school year, e.g. 2026-27, with start and end dates.
4. **Classes**: press **Add Pakistani classes and subjects** to fill Nursery to Class 10, FSc, ICS,
   FA and common subjects. Remove what you do not teach; add your own.
5. **Groups**: sections of a class (5-A, 5-B) or academy batches, with seats, class teacher and
   subject teachers.
6. **Fees**: fee heads (Admission, Tuition…) and the monthly rate for each class (details below).
   You can skip it and do it in **Settings → Fees** later, but before the first fee month.
7. **Staff**: invite now or skip (section 3).
8. **Done** → **Open Maktab**. Maktab will not open until there is at least one group (students are
   admitted into a group); **Back to groups** takes you there.

You can run it again later: **Settings** → **Run the setup wizard** (top right, owner only).

**Fee heads and rates** (wizard step 6, or **Settings → Fees** any time; the late fine, sibling rule
and accounts are only in Settings). Do this before the first admission, so admission fees are
charged:

- **Fee heads**: Admission (once), Tuition (monthly), Exam (per term), Other. English and Urdu names.
- **Rates**: an amount per head for each class (or group), from a date. A rate is never edited: to
  change it, add a new rate from a date; earlier months keep the old rate.
- **Late fine**: on/off, "fine after day of the month", fixed amount or percent, optional cap.
- **Sibling concession**: e.g. 3rd child 25% off (suggested at admission).
- **Accounts**: one cash drawer per collector, plus the school's bank and wallets (JazzCash,
  EasyPaisa). If you start mid-year, the owner enters each account's **Opening balance** once,
  before any money moves.
- The receipt prefix is locked after the first receipt.

Screenshot: onb-02-wizard-school, onb-03-wizard-classes, onb-04-settings-fees

## 3. Inviting staff / عملے کو دعوت

ہر شخص اپنے گوگل ای میل سے سائن اِن کرتا ہے۔

Settings → Staff → **Invite staff**: Google email, name, role (and groups for a teacher). They then
sign in with that Google account. Staff who never use the app (e.g. a guard on the payroll) are
added with **Add staff without login**.

| Role | Sees and does |
|---|---|
| Owner | Everything: settings, staff and roles, backup, audit log, all money and reports. |
| Admin | Like the owner except roles, backup and the audit log. Generates fees, gives concessions, approves payslips, corrects registers. |
| Accountant | Students, fee counter, receipts, own cash drawer, expenses, payroll (not the owner's pay), send queue. Cannot reverse receipts or generate fees. |
| Teacher | Own groups only: attendance, students of those groups, absence messages, own payslips. No money. |

Have **two people with Owner or Admin**. Nobody can approve their own payslip; an owner on the
payroll needs a second owner or admin to approve it.

Screenshot: onb-05-staff-invite

## 4. First admissions / پہلے داخلے

پہلے سرپرست کا فون نمبر تلاش کریں: شاید بہن بھائی پہلے سے موجود ہو۔

**One student**: Students → **Admit**.

1. **Guardian phone** → **Find family**. If a brother or sister is already here, tap **Yes, same
   family**; otherwise **No, new family** (family name, area, address).
2. **Guardians**: name, relation, phone, WhatsApp number (blank = same as phone), message language,
   and the tick box **"Agrees to receive WhatsApp messages from the school"**. Ask the parent; without
   this tick Maktab will tell staff to call instead of sending WhatsApp.
3. **Student**: name, father name, gender, date of birth, B-form, photo (**Take or choose photo**),
   admission no. (blank = next number).
4. **Class**: choose the class or batch, start date, roll no. (blank = next).
5. **Admit student**. The admission fee and the current month's fee are charged from the rates.

The date of birth matters later: the parent page asks for the child's birth year.

**Many students (CSV)**: Students → **Import CSV** → **Download template**, fill one student per row
in a spreadsheet, save as CSV → choose the file → **Check file** (shows Will add / Skip / Error per
row) → fix errors → **Import N students**. If it stops part-way, choose the same file again: rows
already imported are kept and skipped.

Fees owed from before Maktab: open the student's family statement → **Opening balance** ("Owed" or
"Advance held"). Old months are never billed again.

Screenshot: onb-06-admission-family, onb-07-admission-student, onb-08-import-check

## 5. First fee month / پہلا فیس کا مہینہ

ہر مہینے فیس بنائیں، کاؤنٹر پر وصول کریں، رسید دیں۔

**Generate the month** (owner/admin): Fees → **Monthly billing** → choose the month → **Preview**
→ check the counts → **Generate**. It runs by itself on the 1st as well; pressing it twice never bills
twice. A group listed under "Finished with no fees" was missing a rate: add the rate, **Re-open
period**, **Generate** again. **Late fines**: **Preview fines** → **Apply fines** (after the fine day).

**Take a payment**: Fees → **Fee counter**.

1. Search by student name, admission no. or guardian phone → **Open**. You see the whole family:
   each child's fees, total due, any advance.
2. Enter the amount received and the method (Cash, Bank, JazzCash, EasyPaisa, Cheque, Other; non-cash
   needs the account it went into). Oldest dues are paid first; you can choose lines instead.
3. Confirm. The receipt number is issued. One receipt per family visit.

**The receipt screen**:

- Paper: **A5** (normal printer) or **58 mm** (thermal printer); receipt language English or Urdu;
  then **Print**. Each should print on one page.
- **Share**: sends a short text (school, receipt no., amount, date) through the phone's share sheet,
  or copies it. For a family payment the last line is the guardian's private parent-page link (made
  for them if they have none, unless the school's default check is a PIN).
- **Send payment-received**: puts a WhatsApp message with the family's private parent-page link in
  the send queue (section 7).
- A wrong receipt is never edited: **Reverse** with a reason (owner/admin), optionally re-enter it
  correctly in the same step.

Screenshot: onb-09-billing-preview, onb-10-counter-family, onb-11-receipt-58mm, onb-12-receipt-a5-ur

## 6. Daily attendance / روزانہ حاضری

استاد فون پر حاضری لیتا ہے۔ انٹرنیٹ نہ ہو تب بھی محفوظ ہو جاتی ہے۔

Teacher, on the phone:

1. **Attendance** shows today's groups; "Not taken" ones need a register.
2. Tap the group. Everyone starts **Present**. Tap a student to change: present → absent → late →
   leave. Add a note if needed.
3. **Save attendance**.

**No internet?** Save anyway. You see "Saved on this phone. It will be sent when the internet is
back." and a "waiting to sync" count. It is sent by itself when the phone is online again and the app
is opened. Do not dismiss a waiting register unless you will take it again.

- Install the app on the phone (Chrome menu → **Add to Home screen** / **Install app**) so it opens
  like an app, also offline.
- "Your phone's clock is ahead": set the phone to automatic date and time, then save again.
- After saving, **Open send queue** shows the absence messages for that class.
- Only owner/admin can correct a saved register (**Correct this register**, reason required).
- Monthly register: Attendance → **Monthly register** → **Print** or **Download CSV**.

Screenshot: onb-13-attendance-today, onb-14-register, onb-15-register-offline

## 7. Send queue / پیغامات کی قطار

ایپ پیغام تیار کرتی ہے؛ آپ واٹس ایپ میں بھیج کر "Sent" دباتے ہیں۔

Maktab does not send WhatsApp messages by itself. It prepares each message (in the guardian's
language, with their private link) and you send it from the school's WhatsApp.

1. Open **Send queue**. Messages are grouped by type: Absent today, Fee due, Fee overdue, Payment
   received, Notice.
2. Tap **Open WhatsApp**. WhatsApp opens with the text ready. Press send in WhatsApp.
3. Come back to Maktab and tap **Sent** (or **Sent & next**). Nothing is marked sent until you tap it.
4. **Skip** with a reason (Wrong number, Told in person, …) if you will not send it.

Consent and numbers:

- A guardian without the WhatsApp consent tick, or with only a landline, shows **"call instead"**.
  Phone them. Fix the number or consent on the student page.
- One message per family. Siblings absent the same day are merged. An absent child marked present
  later is skipped automatically.
- **Compose notice** (owner/admin): write once in English and/or Urdu, send to all families, one class
  or chosen families. For class WhatsApp groups use **Copy all texts for this class** (absence and
  notice texts only; fee texts are private).
- Message texts: Settings → Messages → message templates (English and Urdu). Keep `{link}` in every
  text.

Screenshot: onb-16-send-queue, onb-17-compose-notice

## 8. Parent links / والدین کا صفحہ

ہر خاندان کا ایک نجی لنک۔ فیس دیکھنے سے پہلے بچے کا سالِ پیدائش پوچھا جاتا ہے۔

Each family gets a private page: today's attendance, this month's attendance %, dues (with how they
are calculated), receipts, notices, in Urdu or English, with a **Listen** button that reads the page
aloud. No login. The link goes out automatically in WhatsApp messages from the send queue.

- **Check before dues**: attendance and notices show to anyone with the link. Fees and receipts ask a
  question first, by default **the birth year of one of the children** (or a 4–6 digit PIN the school
  gives). Five wrong answers lock the check for 15 minutes. It is a speed bump against a forwarded
  link, not a password.
- On the student page (or family statement) → **Parent page link**: **Create link** (choose the check,
  then **Copy link** or **Send via WhatsApp**; it is shown only once), **New link** (the old one stops),
  **Revoke**. "Recent visits" shows when it was opened.
- Settings → Messages: the school default check, and **Revoke all parent links** (owner, for a leak).

Screenshot: onb-18-parent-link-panel, onb-19-parent-page-ur, onb-20-parent-gate

## 9. Cash closing / روزانہ کیش بند کرنا

دن کے آخر میں گنی ہوئی رقم درج کریں اور دراز بند کریں۔

Every collector has their own cash drawer. It opens with the first cash receipt of the day, or with
**Open drawer** and an opening float.

At the end of the day: **Cash** → today's drawer shows **Expected** (cash received minus cash paid
out). Count the cash, enter **Counted cash (Rs)**, see the **Variance**, **Close drawer**.

- Giving cash to the owner or depositing it in the bank: **Handover / bank deposit** (a transfer,
  never income or expense).
- A closed drawer takes no more entries. Only owner/admin can **Reopen**, with a reason. Cash cannot
  be entered for a past day.

Screenshot: onb-21-cash-close

## 10. Month-end / مہینے کا اختتام

نادہندگان کو یاد دہانی، رپورٹیں، تنخواہیں۔

- **Defaulters** (Fees → Defaulters): who owes past the due date, by class and months overdue.
  **Remind all** (Fee overdue or Fee due) queues one message per family; families reminded in the last
  few days are skipped (the number of days is in Settings). **Print list** for class teachers.
- **Reports**: fee register (one class, one month), collection by collector, concession register,
  sponsor statements, monthly attendance register, expense register, salary register, income vs
  expense, cashbook, account balances. All print and CSV.
- **Expenses**: record each with category, amount, paid from (drawer or bank), optional bill photo.
  A wrong one is voided with a reason.
- **Salaries**: Salary → **Prepare payslips** for the month → check lines (allowances, deductions,
  advance recovery) → **Approve** (owner/admin, never your own) → **Pay** (amount, from account) →
  **Print slip**. Staff advances: **Advances**. Teachers see their own under **My payslips**.
- **Concessions**: student page (fees part) or family statement → **Reduce fee** (reason, % or amount, from date). End it with a date
  and reason; a change is end + new row.

Screenshot: onb-22-defaulters, onb-23-reports-hub, onb-24-payslip

## 11. Backups / بیک اپ

ہر رات خودکار بیک اپ؛ مالک کبھی کبھی "Download everything" بھی کرے۔

Owner: **Settings → Backup**.

- **Nightly backup**: the last run (OK / Partial / Failed), size and copies. It runs every night at
  02:30 Pakistan time, encrypted, to two cloud stores. If it shows Failed or an alarm says backups
  have not run, tell the maintainer.
- **Download everything**: one ZIP with every table as CSV, the database structure and a README. Do it
  monthly and keep it safe (it holds every family, phone number and CNIC).
- **Undo recent damage (Time Travel)**: a wrong change noticed within 7 days can be undone by the
  maintainer, but everything entered after that minute must be typed in again from paper receipts.
- **Restore drill (once a term)**: tick the steps with the maintainer, then **Record drill**.
- **Alarms** also show as a banner on the owner's dashboard.

The backup key and the parent-link secret are held by two trustees. Losing the key means losing every
backup.

Screenshot: onb-25-settings-backup

---

Help: ask the maintainer (maktab@conceptlix.com). Technical runbooks: docs/backup.md,
docs/restore.md, docs/deploy.md, docs/pilot-checklist.md.
