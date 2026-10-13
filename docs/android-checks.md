# Android checks (real phone, Chrome)

Manual checks that desktop tests cannot prove (PLAN §12 experiments 3, 4 and 6, "still needs
Android"). Run them on a real Android phone in Chrome, ideally one staff phone and one low-end
guardian-type phone (5.5" screen). Use demo data or a test family, never a real parent's number.

For every check write down: pass/fail, phone model, Android version, Chrome version
(Chrome → ⋮ → Settings → About Chrome), and anything odd. A screenshot or screen recording helps.

## 0. Open /diag first

1. Sign in as the **owner** at https://maktab.conceptlix.com.
2. Open https://maktab.conceptlix.com/diag (hidden page, owner only; not in the menu).
3. It shows:
   - online state;
   - outbox count (attendance submissions waiting on this phone);
   - service-worker status;
   - storage persisted? (yes/no);
   - speech voices available, and whether an **Urdu** voice exists;
   - Web Share support and `canShare(files)` support;
   - display mode (`browser` or `standalone`).
4. Tap **Copy report** and paste the text into your report. Do this again whenever a step below says
   "check /diag".

Report: the pasted /diag text.

## 1. Install

Steps: in Chrome, wait for the install banner or use ⋮ → **Add to Home screen** / **Install app**.
Open Maktab from the home-screen icon. Check /diag.
Expected: the Maktab icon is on the home screen (not a blank or generic icon); it opens without the
Chrome address bar; /diag display mode = `standalone`.
Report: banner shown or menu used; icon looks right; display mode.

## 2. Urdu rendering and RTL (5.5" screen)

Steps: switch the language to اردو. Open Dashboard, Students, a student page, Attendance register,
Fee counter with a family, Send queue, Settings.
Expected: Nastaliq script, no cut-off dots or overlapping lines; layout right-to-left (menu, back
arrows, table columns mirrored); all numbers, dates and amounts in English digits and readable;
buttons not cut off; no sideways scrolling of the page.
Report: screen names with any clipping, overlap or wrong direction (screenshot each).

## 3. WhatsApp link with Urdu text

Steps: make sure a test guardian has message language Urdu, WhatsApp consent and your own test
number. Queue a message (e.g. mark the child absent and save, or Defaulters → **Remind all**). Open
**Send queue** → that row → **Open WhatsApp**.
Expected: WhatsApp opens on the right chat with the whole Urdu text prefilled, letters joined and in
order, numbers intact, the parent link alone on the last line. Send it, return to Maktab: the tab is
still there (not reloaded to the login screen); tap **Sent** and the row is marked sent.
Report: text intact yes/no (screenshot of WhatsApp before sending); did Maktab survive the switch.

## 4. Receipt share and PDF

Steps: Fee counter → take a small test payment → receipt screen.
a. Tap **Share**. b. Tap **Print** → choose **Save as PDF** → save → open the Files/Downloads app and
share the PDF to WhatsApp. Check /diag (Web Share, canShare(files)).
Expected: a. the share sheet opens with the receipt text (school, receipt no., amount, date), and
WhatsApp is offered. b. the PDF saves, opens with the right content, and attaches in WhatsApp.
Report: which share targets appeared; PDF page count; any font problem in the PDF.

## 5. Print sizes: 58 mm and A5

Steps: on the receipt screen choose **58 mm**, then **Print**; in Chrome's print preview read the page
count. Print to the thermal printer if one is available. Repeat with **A5** in English, and **A5** with
receipt language Urdu.
Expected: 58 mm = **1 page**; A5 English = 1 page; A5 Urdu = 1 page; Urdu text in Nastaliq, not boxes.
On a real thermal printer: the receipt is one strip, nothing cut on the sides.
Report: page count for each (58 mm / A5 en / A5 ur); printer model if used; photo of the printout.

## 6. Offline register (airplane mode, app killed)

Steps:
1. Sign in as a teacher (or owner) online; open **Attendance** and the group's register once.
2. Turn on **airplane mode**.
3. Take attendance (mark two absent) → **Save attendance**. Expect "Saved on this phone…".
4. Check /diag: outbox count = 1.
5. Swipe the app away from recent apps (kill it). Wait 1 minute.
6. Reopen Maktab, still in airplane mode.
7. Expected: the app opens (no dinosaur page); the "waiting to sync" count is still shown; /diag
   outbox count still 1.
8. Turn airplane mode off. Bring the app to the front.
9. Expected: within a minute the waiting count goes to 0; /diag outbox 0; on a laptop the register is
   saved once, with the two absentees, and absence messages appear in the send queue.
Report: each expected point yes/no; /diag reports from steps 4, 7 and 9.

## 7. Sign-out while offline

Steps: online, sign in; save one register offline as in check 6 but do not reconnect. Still offline,
tap **Sign out**. Then reconnect and, on a laptop as owner, look at that user's sessions.
Expected: right after Sign out (still offline) the app is at the sign-in screen and this phone holds
no school data (reopening offline shows nothing from before); after reconnecting, the old session is
revoked on the server (it no longer works). Note whether the unsent register was lost and whether the
app warned you first.
Report: what you saw at each step; was there a warning about unsent registers.

## 8. Parent page on a guardian phone

Steps: create a parent link for the test family (student page → **Parent page link** → **Create
link** → **Send via WhatsApp** to the test guardian phone). On that phone open the link from WhatsApp.
Switch to Urdu. Answer the check with the child's birth year. Tap **Listen**. (/diag needs an owner
sign-in, so on the guardian phone look instead at Android Settings → Text-to-speech → language to see
whether an Urdu voice is installed.)
Expected: the page opens without login; attendance shows before the check; dues and receipts after
the correct birth year; a wrong answer says "That does not match"; **Listen** reads the page aloud in
Urdu (or, with no Urdu voice, behaves sensibly: reads English or says it cannot).
Report: open time on mobile data; Listen voice language; any text cut off.

## 9. Camera photo for a student

Steps: Students → a student (the student page; or during **Admit**) → **Take or choose photo** → camera → take a photo → **Upload
photo**.
Expected: the camera opens (permission asked once); "Photo ready (N KB)" shows N ≤ 100; "Photo saved";
the photo shows on the student page and in the register.
Report: KB shown; upload time; orientation correct (not sideways).

## Results

| Check | Pass / fail | Phone model + Android + Chrome version | Notes |
|---|---|---|---|
| 0 /diag report | | | |
| 1 Install | | | |
| 2 Urdu / RTL | | | |
| 3 wa.me Urdu text | | | |
| 4 Share / PDF | | | |
| 5a 58 mm = 1 page | | | |
| 5b A5 en = 1 page | | | |
| 5c A5 ur = 1 page | | | |
| 6 Offline register + swipe-away | | | |
| 7 Sign-out offline | | | |
| 8 Parent page + Listen | | | |
| 9 Camera photo | | | |

Tested by: ______ Date: ______ Copy the filled table into docs/pilot-checklist.md §5 notes.
