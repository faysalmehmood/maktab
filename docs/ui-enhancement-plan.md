# UI enhancement plan

Status: proposal, written 2026-10-13 after a design review of the web app at `333c0a6` (M0 to M6).
Audience: the agent who will review and implement it.
Nothing in this plan has been implemented. No app code was changed during the review.

## 1. How to read this plan

- **Reference mock:** `docs/design/ui-mock.html` (open it in a browser). It is a clickable sketch of the
  app today and the proposed design, on desktop and phone, with a school switch, the sign-in page and
  step 1 of the new setup. Published copy: https://claude.ai/artifact/WGNuG3gdk41VKfiX4xmGRm (private
  to the owner).
- The mock is a direction, not a spec. Its "Today" side is a rebuild from screenshots. Its data is
  invented. Where the mock and this document disagree, this document wins.
- `docs/PLAN.md` stays canonical for product rules. Section 3 below lists where this plan conflicts
  with a logged decision. Do not act on those items until the owner confirms them, then record the
  outcome in the PLAN decision log.

### What the review covered

- 37 routes captured as owner at 1280 px and 390 px in English, and 390 px in Urdu, on a seeded local
  database with the smoke scripts run for extra data. About 25 captures were inspected closely.
- The first-run wizard, walked on an empty database at 390 px.
- Code read: `apps/web/src/styles.css`, `components/AppShell.tsx`, `App.tsx`, `components/ui/*`,
  `pages/Setup.tsx`, `components/setup/school.tsx`.

Not reviewed: the parent page (`/p`), dialogs, Settings sub-tabs other than Account, teacher and
accountant role views, printed output, and any real Android device. Review those before changing them.

## 2. Decisions so far

Confirmed by the owner in the review conversation:

| Topic | Decision |
|---|---|
| Branding principle | The school is in front, Maktab is behind. Each installation shows its own school's badge, name and colour prominently |
| Product default | Maktab keeps a default name, theme and mark, used when no school identity is set |
| Default Maktab mark | Direction A: the takhti, redrawn (section 8) |
| Maker's mark | A small "Runs on Maktab" line is acceptable |
| Pilot school | Global Science Academy, Pakpattan. Short name "GSA". It has no logo yet, so the generated badge is its starting identity |
| Sign-in page | The owner liked the branded direction. Section 7 recommends keeping it focused |

Proposed by the reviewer, not yet confirmed. Treat as recommendations and confirm before building:

- The overall visual direction ("calm ledger", section 4).
- Grouped navigation and the phone bottom bar (section 5).
- The five-step setup (section 7).
- Everything in section 3.

## 3. Conflicts with PLAN.md that need the owner's answer

| # | Proposal | Conflicts with | Reviewer's recommendation |
|---|---|---|---|
| 1 | Controls 36 px high for mouse pointers, 44 px on touch | PLAN §15 note: "Tap targets 44 px everywhere, no pointer media-query exceptions" | Allow the exception. 44 px rows of repeated buttons are the main cause of the heavy desktop look |
| 2 | A web font for Latin text (the mock uses Figtree) | The app uses system fonts; Urdu loads Noto Nastaliq only when needed | Optional. If adopted, self-host one variable file, cache it in the service worker, and measure the cost on 3G. System fonts remain an acceptable answer |
| 3 | Per-school accent colour | Brand teal is fixed in `brand/README.md` and the manifest | Adopt, from a curated set only (section 6) |
| 4 | Installed app name and icon per school | The manifest and icons are static files built by `vite-plugin-pwa` | Adopt, as the last branding item (section 6.5) |
| 5 | Setup gains a Fees step and a guard against finishing with no classes | PLAN §14.1 already lists fees in the wizard, so this restores the plan | Adopt |

Timing: this work touches files that milestone work also edits. Recommended: start after M6 closes, on
a branch, and run it as part of M7 polish under the PLAN §15 loop.

## 4. Findings: the app today

The foundation is sound: shadcn components, consistent touch targets, working RTL, and a good fee
counter and attendance register. The problems are hierarchy, navigation and density.

### 4.1 Shell and navigation

- `NAV` in `components/AppShell.tsx` is 13 flat items with no grouping.
- Cash is both a sidebar item and a card in the Fees hub. Advances is both a sidebar item and a button
  on Salary.
- On phones the only navigation is a hamburger. Attendance, the fee counter and the send queue, the
  phone-first tasks, are two taps away.
- The top bar holds only the language toggle and Sign out. No logo, school name, user or search.

### 4.2 Layout and visual system

- Every section is a bordered, shadowed card, sometimes nested (Monthly billing).
- Pages use five different max widths (`max-w-2xl` to `max-w-5xl`), all left-aligned, leaving the right
  third of a desktop empty.
- All buttons are 44 px on desktop. Repeated row actions form heavy columns: "Edit pay" on every staff
  row, "Re-open period" on every class.
- Page titles and card titles are close in size. There is no clear type scale.
- Dates show as `2026-10-13` and periods as `2026-10`, while date inputs show `13/10/2026`.
- Status colours are ad hoc Tailwind palette classes. "Not taken" is alarm red. The P/A/L/E chips are
  saturated.
- **Dark mode is not wired.** `.dark` tokens exist in `styles.css` but nothing ever sets the class.
  PLAN §11 promises light and dark.
- 24 places show plain "Loading…" text. There are no skeletons.
- 61 native `<select>` and 45 native date or month inputs. Acceptable on Android, plain on desktop.

### 4.3 Screens

- **Dashboard:** 13 tiles of equal weight. "Dues outstanding" and "Defaulters" each appear twice. Zeros
  take as much room as real numbers. Orphan tiles leave gaps. About three screens tall on a phone.
- **Students list:** a phone-style list stretched across desktop. Generic icon instead of the initials
  avatar the register already has. No class, dues or attendance columns. The reviewer found no paging
  in the list page; confirm how it behaves at 1,000 students.
- **Student profile:** one scroll of over 2,000 px. Dues and attendance are at the bottom. The
  attendance calendar is large empty boxes. The fee table header shows "Fee" twice.
- **Attendance today:** twelve cards each with four coloured chips, and no summary of how many are left.
- **Register:** works well. One button cycles four states, so "leave" takes three taps.
- **Fees hub:** eight link cards, overlapping the sidebar.
- **Expenses on phone:** five stacked filter fields come before the first row. "Void" is the only
  button on each row, which contradicts PLAN §11 ("No destructive buttons on list rows").
- **Receipt:** "Reverse" is bright red beside Print.
- **Send queue:** ten full-text cards make a long page. Urdu previews are laid out left to right, so the
  full stop lands on the wrong side.
- **Reports:** the income chart is small and uses blue and orange that are not in the palette.

### 4.4 Branding

- `school.logo_key` and `POST /api/school/logo` exist. The logo appears in two places only: the A5
  receipt (`components/fees/ReceiptPrint.tsx`) and the settings preview.
- The sidebar, sign-in page, browser tab and installed app all say "Maktab". The school name appears
  only as the dashboard heading.
- The parent page and the thermal receipt show no logo (PLAN already carries "parent receipt logo" to
  M7; the logo route needs a session).
- There is no short name, city or colour field on `school`.

### 4.5 First-run setup

Seven steps in `pages/Setup.tsx`: school, mode, session, programmes, groups, staff, done.

- **Logo upload is missing on the first visit.** `{dto && <LogoUpload … />}` renders only after the
  school row exists, so it appears only if the owner goes to step 2 and comes back.
- **Setup can finish empty.** The reviewer reached "Your school is ready" with no classes and no groups.
- **Fees are not in the wizard**, although PLAN §14.1 lists fee heads, rates and the fine rule there.
- `setup.doneBody` still says "Fees come in a later update" (en and ur in `packages/shared/src/i18n.ts`).
- Step 1 asks for a receipt prefix and default language before the school has a class.
- `school.logoHelp` says "up to 200 KB" while the API allows 512 KB (`MAX_LOGO_BYTES`). There is no crop
  or resize step for logos; `lib/image.ts` already resizes student photos.
- The progress bar has no step names. The finish is a tick and an empty dashboard.
- The one-tap "Add Pakistani classes and subjects" button is the strongest part and is under-used.

### 4.6 Defects worth fixing even if nothing else is adopted

1. Logo upload hidden on first visit to setup step 1.
2. Setup can complete with no classes or groups.
3. Stale `setup.doneBody` copy, both languages.
4. Urdu message previews in the send queue need `dir="rtl"` and `lang="ur"`.
5. Duplicate "Fee" column header in the student fees table.
6. Dark mode tokens are never applied.
7. Logo size hint does not match the API limit.
8. "Void" as the only visible row action on Expenses.

## 5. Proposed design

### 5.1 Direction

"Calm ledger": the school's identity leads, the surface is quiet, and colour means something.

- Neutral greys biased slightly toward the brand hue instead of pure grey.
- One accent (the school's colour, teal by default) for primary actions and the active state.
- Status colours are separate from the accent and fixed for every school: present or paid (green),
  absent or overdue (red), late or due (amber), leave or informational (blue). Each has a soft
  background and a strong text tone, defined as tokens for light and dark.
- Borders and shadows mark separate objects only. Most sections become plain panels with a header row.

### 5.2 Tokens and formatting

- Add semantic tokens to `styles.css`: `--success`, `--warning`, `--danger`, `--info`, each with a soft
  variant, plus sidebar tokens. Replace the hardcoded `amber-*`, `red-*`, `emerald-*`, `sky-*` classes.
- Wire dark mode: follow the system setting, add a manual switch in the account menu, and remember the
  choice per device.
- Type scale: page title 22 px bold, section title 15 px semibold, body 14 px, meta 12.5 px.
- Tabular numerals wherever digits line up.
- One money component: a small muted "PKR" followed by the amount. Keep Latin digits and the existing
  `bdi`/`.num` isolation rules.
- One date formatter for display: "13 Oct 2026" and "Oct 2026". Inputs keep native controls.
- Density, if conflict 1 is approved: control height is a token, 36 px under `(pointer: fine)` and
  44 px otherwise.

### 5.3 Shell and navigation

Desktop sidebar, top to bottom:

1. School badge, school name, city.
2. Home.
3. People: Students, Classes (today's Groups).
4. Daily work: Attendance, Messages (with the waiting count).
5. Money: Fees, Expenses, Payroll (Salary and Advances together), Reports.
6. School: Settings, Audit log.
7. Account menu: name and role, language, theme, sign out. Then "Runs on Maktab".

Rules:

- Keep deriving items from the permission matrix (`navFor`). The grouping is presentation only. Hide a
  group heading when the role sees none of its items.
- Keep the teacher variants: "My groups", the dues summary, "My payslips".
- Cash moves under Fees as a tab. Advances moves under Payroll.

Top bar: a student search (name, admission number, phone) that opens the profile, and the sync state.
The offline pending count and `SyncBanner` must stay visible; attendance depends on them.

Phone: a bottom tab bar with the role's daily tasks and "More". For office roles: Home, Attendance,
Fees, Messages, More. For a teacher: Home, Attendance, My groups, More. "More" opens a sheet with the
rest. Respect the bottom safe-area inset.

### 5.4 Page template and shared components

Build these once, then move screens onto them:

| Component | Purpose |
|---|---|
| `PageHeader` | Back link, title, subtitle, one primary action, secondary actions, overflow menu |
| Width tiers | Forms about 680 px, detail pages about 1080 px, tables full width. Centred |
| `Panel` | Section with a header row; replaces most cards |
| `DataTable` | Desktop table with sticky header and clickable rows; renders as a row list on phones |
| `FilterBar` | Inline on desktop; on phones one "Filters" button opening a sheet, with active filters as chips |
| `StatusBadge` | The four status tones plus neutral |
| `Stat` | Label, value, optional comparison |
| `Avatar` | Initials or photo; reuse the register's version |
| `EmptyState` | What will appear here and the action that fills it |
| `Skeleton` | Replaces "Loading…" text in lists, tables and stats |
| `RowMenu` | A "more" button holding rare or destructive row actions |
| `SegmentedControl`, `Tabs` | Small option sets and in-page sections |

### 5.5 Screens

**Home**

- A "today" row of three cards, each with one action: attendance registers (count taken, one block per
  class that opens its register, a "take next" button), collected today (total, split by method, open
  counter), messages to send (count by type, start sending).
- "Needs attention": a list that shows only non-zero items, each linking to the fix.
- One strip for the month: income, spending, net, dues outstanding, each compared with last month.
- Absent today as a compact list with the message state per family. Registers still to take.
- Each role sees only the cards its grants allow.

**Students**

- Desktop: a table with student (avatar, name, admission number), class, guardian, phone, dues,
  attendance. Phone: a row list with name, class and a dues badge.
- Class and status filters. Server-side paging or incremental loading sized for 1,000 students.

**Student profile**

- Header: avatar, name, class, admission number, status. Actions: Collect fee (primary), Message, and
  an overflow menu for Edit, Mark left, Change photo.
- Summary strip: this child owes, attendance this month, guardian, admitted.
- Tabs: Overview (guardians, parent link, siblings, class history), Fees, Attendance (compact colour
  calendar), Family (family dues, advance, statement).

**Attendance**

- Progress first ("6 of 12 registers taken"), then two lists: To take, Taken.
- Register: each student gets four direct choices (present, absent, late, leave). Letters on phones,
  words on desktop. Live counts in a sticky save bar. Keep "everyone starts present", the note button,
  history, corrections and all offline behaviour exactly as they are.

**Fees**

- One area with tabs: Counter, Defaulters, Monthly billing, Cash drawer. Concessions, Sponsors, Fee
  register and Collection report move under Reports or a "More" tab; decide during implementation.
- Counter: family and dues lines on one side, payment on the other. Quick amounts ("Full due", "One
  month"). A plain sentence states what the amount will pay before confirming. The result screen shows
  the school header, receipt number, new balance, then Print, Send on WhatsApp and New payment.
- None of the money rules change: idempotency key per attempt, `stale_dues` handling, the confirmation
  with resulting balance, backdating rules.

**Messages**

- A compact list with tabs by type, and a focus mode ("Start sending") that shows one family at a time
  in large type: Open WhatsApp, then "Sent, show the next one" or Skip, with progress.
- Urdu text renders right to left in Nastaliq.
- Rules unchanged: Sent is always an explicit tap and is offered only after Open for WhatsApp rows.

**Other screens** (Expenses, Payroll, Reports, Audit, Settings): move onto the shared parts. Expenses
gets the filter sheet on phones and "Void" moves into the row menu. Receipt: "Reverse" moves into the
overflow menu and keeps its reason dialog. Settings: tabs become a side list on desktop.

## 6. Branding: the school in front

### 6.1 Identity fields

Add to `school` (forward-only migration; follow the PLAN §15 schema rules, no CHECK on the existing
table):

| Field | Notes |
|---|---|
| `short_name` | Up to 4 characters, for the badge and phone icon. Suggested from the initials of the name ("Global Science Academy" gives "GSA") and editable |
| `city` | Shown as the second line under the name. Keep `address` for receipts |
| `brand_color` | A key from a curated set, not a free hex value |

`name`, `name_ur` and `logo_key` already exist.

### 6.2 The badge

- Until a logo is uploaded, draw a badge from the short name and colour: a roundel with a ring and the
  letters. Every school has an identity from the first minute.
- An uploaded logo replaces the badge everywhere.
- Upload flow: accept a phone photo, offer a square crop, resize in the browser (reuse the approach in
  `lib/image.ts`), then upload. Fix the size hint to match the API limit.

### 6.3 Colour

- Offer about eight accent colours, each pre-tested for contrast as a button background and as text,
  with a matching dark-theme value and sidebar tones. The mock has five worked examples.
- Status colours never change with the school colour.
- Default is Maktab teal.

### 6.4 Where the school identity appears

| Place | Shows |
|---|---|
| Sidebar header, phone top bar | Badge, name, city |
| Sign-in page | Badge, name in English and Urdu, city |
| Parent page | Badge and name at the top |
| A5 and thermal receipts, payslips, printed reports | Badge or logo with name and city. Thermal needs a one-colour version |
| Fee counter result screen | The same header as the receipt |
| Browser tab title | Short name first, for example "GSA, Fee counter" |
| WhatsApp messages | Already signed with the school name; no change |

The sign-in page and the parent page have no session. They need a public, read-only source for name,
Urdu name, city, short name, colour and the logo image. Design it with the permission matrix and
keep the existing privacy headers on `/p`.

### 6.5 Installed app name and icon

Each school is its own installation, so the installed app can carry the school's short name and badge.
This needs the manifest and icon files served per school by the Worker instead of built statically.
Points to design before building: maskable safe zone for generated icons, the Apple touch icon,
service-worker precache of the manifest, and what an already-installed app does when the school changes
its logo. Do this item last and treat it as optional for the pilot.

### 6.6 Maktab's presence

- "Runs on Maktab" with the small mark: sidebar footer, sign-in page, Settings → About.
- With no school configured (before setup), the app shows full Maktab branding in teal.
- Keep the AGPL notice and source link in About.

## 7. Sign-in page and first-run setup

### 7.1 Sign-in page

Keep it focused. It is the school's front door, not a website.

- Desktop: two halves. One half is the school in its colour: badge, name in both scripts, city, and
  "Runs on Maktab" at the foot. The other half has one job: "Staff sign-in" with the Google button and
  the invited-staff note.
- Phone: the school band on top, sign-in below.
- One block for parents: "Parents do not sign in here. Open the link the school sent you on WhatsApp,
  or call the office", with the school phone.
- Language toggle stays.
- No news, photos or public data. Nothing here should need upkeep.

### 7.2 Setup in five steps

| Step | Content |
|---|---|
| 1. Your school | Name, Urdu name, city, short name, logo or generated badge, colour. A live preview of the sign-in page, receipt header and phone icon updates as the owner types |
| 2. School or academy | The existing mode choice, plus default language |
| 3. Classes and sections | Tick classes from the Pakistani ladder (the existing seed, promoted to the main path), set the number of sections per class, add academy batches. Session dates are prefilled and editable here |
| 4. Fees | Monthly fee per class, due day, late fine on or off. Receipt prefix defaults from the short name |
| 5. Staff | Invite now or skip |

Then a finish screen that summarises what was created (classes, sections, fee heads, invites).

Rules:

- The logo upload is available on the first visit to step 1.
- Setup cannot finish with no class and no group. Say what is missing and link back to the step.
- Show step names in the progress indicator.
- After setup, Home shows a short "first week" checklist until done: add or import students, invite
  teachers, take the first register, install the app on your phone.
- Setup stays re-enterable from Settings.

## 8. Default Maktab mark

Chosen direction: **A, the takhti redrawn.**

- Keep the idea in `brand/README.md`: the wooden writing slate with the letter meem.
- Problems to fix: the silhouette reads as a clipboard or ID tag, and the geometric meem reads as a
  "p" or "9".
- Brief: give the slate its handle with a hole, write the meem as a recognisable letter, and consider a
  faint writing line. It must stay legible at 14 px for the "Runs on Maktab" line and at 16 px as a
  favicon.
- The sketch in the mock is a direction only. The final mark needs a proper drawing pass and owner
  sign-off, then regenerate the files listed in `brand/README.md` and the icons in
  `apps/web/public/icons/`.

## 9. Suggested order of work

| Phase | Scope | Done when |
|---|---|---|
| 0 | Owner confirms sections 2 and 3. Fix the defects in 4.6 | Decisions logged in PLAN; defects closed with tests |
| 1 | Tokens, status colours, dark mode, type scale, money and date formatting, density token | No hardcoded palette classes remain; dark theme works on every screen reviewed |
| 2 | Shell: grouped sidebar, account menu, top bar search, phone bottom bar | Every role's menu matches `navFor`; offline indicators still visible |
| 3 | Shared components in 5.4 | Used by at least Students and Expenses |
| 4 | Branding: fields, badge, colour set, placements, public identity source | GSA shows its badge on shell, sign-in, parent page and receipts with no logo uploaded |
| 5 | Sign-in page and five-step setup | An empty install can be set up on a phone without leaving the wizard, including fees |
| 6 | Screens in 5.5, one at a time: Home, Students, Profile, Attendance, Fees, Messages, then the rest | Each screen passes the checks in section 10 |
| 7 | Mark redraw, per-school installed icon and name | Owner signs off the mark |

Phases 1 to 3 change no behaviour and can be reviewed on their own. Phase 6 is the largest.

## 10. Constraints and checks for every change

- Every new string goes in `packages/shared/src/i18n.ts` in English and Urdu.
- RTL: use logical properties (`ms-`, `me-`, `start`, `end`). Mirror directional icons.
- Numbers, dates and amounts stay in Latin digits inside `bdi`/`.num`.
- Phone first: check at 360 px and 390 px. No horizontal scroll.
- Touch targets stay at least 44 px on touch devices.
- Do not change money rules, permission checks, offline behaviour or print layouts as a side effect.
  Print CSS in `styles.css` is tuned from experiment 3; re-run `apps/web/scripts/print-pages.mjs` for
  the thermal receipt after touching receipts.
- Keep office screens lazy-loaded so a teacher's phone does not download them.
- The web tests query by text and role. Expect label changes to break tests; update them deliberately
  and do not weaken assertions.
- Before each merge: `npm run typecheck && npm run lint && npm test && npm run build`, the smoke
  scripts, and a browser pass in English and Urdu, light and dark, phone and desktop.

## 11. Open questions for the owner

1. Approve the density exception (36 px for mouse pointers)?
2. Web font or system fonts?
3. Is the grouped navigation and the phone bottom bar approved as drawn?
4. Where should Concessions, Sponsors, Fee register and Collection report live once the Fees hub goes?
5. Which accent colours should the curated set offer, and what is GSA's colour? The mock's blue is a
   placeholder.
6. Is the per-school installed icon and name wanted for the pilot, or later?
7. When should this start relative to M7?
