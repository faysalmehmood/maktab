import type { GuideTask } from './types';

/* Month-end, parents, staff, keeping data safe, phone tips. */

export const TASKS_B: readonly GuideTask[] = [
  {
    id: 'generate-fees',
    section: 'month',
    roles: ['owner', 'admin'],
    title: { en: "Generate the month's fees", ur: 'مہینے کی فیس بنائیں' },
    summary: {
      en: 'One button bills every class for the month. It also runs by itself on the 1st.',
      ur: 'ایک بٹن سے ہر کلاس کی مہینے کی فیس بن جاتی ہے۔ یکم کو یہ خود بھی چلتا ہے۔',
    },
    steps: [
      {
        to: '/fees/billing',
        text: {
          en: '**Fees** → **Monthly billing**. Choose the **Month**.',
          ur: '**Fees** → **Monthly billing**۔ **Month** چنیں۔',
        },
      },
      {
        text: {
          en: 'Press **Preview** and check the counts per class.',
          ur: '**Preview** دبائیں اور ہر کلاس کی گنتی دیکھیں۔',
        },
      },
      {
        text: {
          en: 'Press **Generate** and confirm. Pressing it twice never bills twice.',
          ur: '**Generate** دبا کر تصدیق کریں۔ دو بار دبانے سے دو بار فیس نہیں لگتی۔',
        },
      },
      {
        text: {
          en: 'A class under "Finished with no fees" had no rate. Add the rate in **Settings** → **Fees**, press **Re-open period**, then **Generate** again.',
          ur: '"Finished with no fees" والی کلاس کا ریٹ نہیں تھا۔ **Settings** → **Fees** میں ریٹ لکھیں، **Re-open period** دبائیں، پھر دوبارہ **Generate**۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Changing a rate by editing it: rates are never edited. Add a new rate from a date; old months keep the old rate.',
        ur: 'ریٹ میں ترمیم کرنا: ریٹ بدلا نہیں جاتا۔ کسی تاریخ سے نیا ریٹ لگائیں؛ پرانے مہینے پرانے ریٹ پر رہتے ہیں۔',
      },
      {
        en: 'Skipping **Preview**: you miss a class with no rate until parents ask.',
        ur: '**Preview** نہ دیکھنا: بغیر ریٹ والی کلاس کا پتا تب چلتا ہے جب والدین پوچھیں۔',
      },
    ],
    links: [{ to: '/fees/billing', label: { en: 'Monthly billing', ur: 'Monthly billing' } }],
    tour: [
      {
        path: '/fees/billing',
        target: 'billing-month',
        title: { en: 'The month', ur: 'مہینہ' },
        body: {
          en: 'Choose the month. The badge says whether it is billed already.',
          ur: 'مہینہ چنیں۔ نشان بتاتا ہے کہ فیس پہلے بن چکی یا نہیں۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'billing-preview',
        title: { en: 'Preview', ur: 'Preview' },
        body: {
          en: 'Shows what will be billed. Nothing is saved yet.',
          ur: 'دکھاتا ہے کیا بنے گا۔ ابھی کچھ محفوظ نہیں ہوتا۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'billing-generate',
        title: { en: 'Generate', ur: 'Generate' },
        body: {
          en: 'Bills the month after you confirm. Safe to press again.',
          ur: 'تصدیق کے بعد مہینے کی فیس بنا دیتا ہے۔ دوبارہ دبانا محفوظ ہے۔',
        },
      },
    ],
  },

  {
    id: 'apply-fines',
    section: 'month',
    roles: ['owner', 'admin'],
    title: { en: 'Apply late fines', ur: 'لیٹ جرمانہ لگائیں' },
    summary: {
      en: 'After the fine day, add the late fine to unpaid tuition.',
      ur: 'جرمانے کے دن کے بعد، ادا نہ ہونے والی ٹیوشن پر جرمانہ۔',
    },
    steps: [
      {
        to: '/settings?section=fees',
        text: {
          en: 'Once: in **Settings** → **Fees** set the late fine (on/off, the day of the month, fixed or percent, optional cap).',
          ur: 'ایک بار: **Settings** → **Fees** میں لیٹ جرمانہ طے کریں (آن/آف، مہینے کا دن، مقررہ یا فیصد، حد)۔',
        },
      },
      {
        to: '/fees/billing',
        text: {
          en: '**Monthly billing** → **Preview fines** shows who will be fined and how much.',
          ur: '**Monthly billing** → **Preview fines** دکھاتا ہے کس پر کتنا جرمانہ لگے گا۔',
        },
      },
      {
        text: {
          en: 'Press **Apply fines**. A fine can be waived at the **Fee counter** by the owner or admin.',
          ur: '**Apply fines** دبائیں۔ مالک یا ایڈمن **Fee counter** پر جرمانہ معاف کر سکتا ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Fining before the fine day: nothing is planned yet, and that is correct.',
        ur: 'جرمانے کے دن سے پہلے لگانا: تب کچھ نہیں بنتا، اور یہ درست ہے۔',
      },
      {
        en: "Sponsored shares are never fined; only the family's part is.",
        ur: 'اسپانسر کے حصے پر کبھی جرمانہ نہیں لگتا؛ صرف خاندان کے حصے پر۔',
      },
    ],
    links: [{ to: '/fees/billing', label: { en: 'Monthly billing', ur: 'Monthly billing' } }],
    tour: [
      {
        path: '/fees/billing',
        target: 'billing-fines',
        title: { en: 'Late fines', ur: 'لیٹ جرمانہ' },
        body: {
          en: 'Fines live next to the month, on the same screen.',
          ur: 'جرمانے اسی اسکرین پر مہینے کے ساتھ ہیں۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'fines-preview',
        title: { en: 'Preview fines', ur: 'Preview fines' },
        body: {
          en: 'See the list first; **Apply fines** appears when there is something to fine.',
          ur: 'پہلے فہرست دیکھیں؛ کچھ لگانا ہو تو **Apply fines** نظر آئے گا۔',
        },
      },
    ],
  },

  {
    id: 'defaulters',
    section: 'month',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Defaulters and reminders', ur: 'نادہندگان اور یاد دہانی' },
    summary: {
      en: 'Who owes past the due date, and one reminder per family.',
      ur: 'کس کی فیس مقررہ تاریخ سے لیٹ ہے، اور ہر خاندان کو ایک یاد دہانی۔',
    },
    steps: [
      {
        to: '/fees/defaulters',
        text: {
          en: '**Fees** → **Defaulters**. Filter by class, months overdue or amount.',
          ur: '**Fees** → **Defaulters**۔ کلاس، لیٹ مہینوں یا رقم سے چھانٹیں۔',
        },
      },
      {
        text: {
          en: 'Press **Remind all**. One message per family goes to the send queue; families reminded in the last few days are skipped.',
          ur: '**Remind all** دبائیں۔ ہر خاندان کا ایک پیغام قطار میں جاتا ہے؛ حال ہی میں یاد دلائے گئے خاندان چھوڑ دیے جاتے ہیں۔',
        },
      },
      {
        text: {
          en: 'Then send them from **Messages** as usual. **Print list** gives class teachers a paper copy.',
          ur: 'پھر معمول کے مطابق **Messages** سے بھیجیں۔ **Print list** سے کلاس ٹیچر کو کاغذی فہرست دیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Expecting **Remind all** to send by itself: it only queues. Open **Messages** to send.',
        ur: 'یہ سمجھنا کہ **Remind all** خود بھیج دے گا: یہ صرف قطار میں ڈالتا ہے۔ بھیجنے کے لیے **Messages** کھولیں۔',
      },
      {
        en: "A sponsored child never makes the family a defaulter for the sponsor's share.",
        ur: 'اسپانسر والے بچے کا اسپانسر حصہ خاندان کو نادہندہ نہیں بناتا۔',
      },
    ],
    links: [{ to: '/fees/defaulters', label: { en: 'Defaulters', ur: 'Defaulters' } }],
    tour: [
      {
        path: '/fees/defaulters',
        target: 'def-filters',
        title: { en: 'Narrow the list', ur: 'فہرست چھوٹی کریں' },
        body: {
          en: 'One class, two months or more, above an amount.',
          ur: 'ایک کلاس، دو یا زیادہ مہینے، کسی رقم سے اوپر۔',
        },
      },
      {
        path: '/fees/defaulters',
        target: 'def-remind',
        title: { en: 'Remind all', ur: 'Remind all' },
        body: {
          en: 'Queues one reminder per family in their language.',
          ur: 'ہر خاندان کو اس کی زبان میں ایک یاد دہانی قطار میں ڈالتا ہے۔',
        },
      },
      {
        path: '/fees/defaulters',
        target: 'def-print',
        title: { en: 'Print list', ur: 'Print list' },
        body: { en: 'A paper list for class teachers.', ur: 'کلاس ٹیچر کے لیے کاغذی فہرست۔' },
      },
    ],
  },

  {
    id: 'income-expense',
    section: 'month',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Income vs expense', ur: 'آمدنی اور خرچ' },
    summary: {
      en: 'How the month went: fees in, expenses and salaries out.',
      ur: 'مہینہ کیسا رہا: فیس آئی، خرچ اور تنخواہیں گئیں۔',
    },
    steps: [
      {
        to: '/expenses',
        text: {
          en: 'During the month, record every expense in **Expenses** with category, amount and where it was paid from (drawer or bank). A bill photo helps.',
          ur: 'مہینے بھر ہر خرچ **Expenses** میں درج کریں: قسم، رقم، اور کہاں سے دیا (دراز یا بینک)۔ بل کی تصویر بہتر ہے۔',
        },
      },
      {
        to: '/reports/income-expense',
        text: {
          en: '**Reports** → **Income vs expense**. Choose the months. You see income, expenses, salaries and the net.',
          ur: '**Reports** → **Income vs expense**۔ مہینے چنیں۔ آمدنی، خرچ، تنخواہیں اور خالص بچت سامنے آئے گی۔',
        },
      },
      {
        text: {
          en: 'Every report prints and downloads as CSV for a spreadsheet.',
          ur: 'ہر رپورٹ پرنٹ ہوتی ہے اور اسپریڈشیٹ کے لیے CSV میں بھی آتی ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Deleting a wrong expense: money is never deleted. Void it with a reason and enter it again.',
        ur: 'غلط خرچ مٹانا: پیسوں کا اندراج مٹتا نہیں۔ وجہ لکھ کر منسوخ کریں اور دوبارہ درج کریں۔',
      },
      {
        en: 'Counting a handover to the owner as an expense: it is a transfer, use **Handover / bank deposit**.',
        ur: 'مالک کو دی گئی نقدی کو خرچ لکھنا: یہ منتقلی ہے، **Handover / bank deposit** استعمال کریں۔',
      },
    ],
    links: [
      {
        to: '/reports/income-expense',
        label: { en: 'Income vs expense', ur: 'Income vs expense' },
      },
      { to: '/expenses', label: { en: 'Expenses', ur: 'Expenses' } },
    ],
    tour: [
      {
        path: '/reports',
        target: 'reports-income-expense',
        click: true,
        title: { en: 'Reports', ur: 'رپورٹیں' },
        body: {
          en: 'All reports are here. Next opens income vs expense.',
          ur: 'تمام رپورٹیں یہاں ہیں۔ "آگے" سے آمدنی اور خرچ کھلے گی۔',
        },
      },
      {
        path: '/reports/income-expense',
        target: 'ie-range',
        title: { en: 'Choose the months', ur: 'مہینے چنیں' },
        body: {
          en: 'From and to; one month or a whole term.',
          ur: 'سے اور تک؛ ایک مہینہ یا پوری ٹرم۔',
        },
      },
      {
        path: '/reports/income-expense',
        target: 'ie-totals',
        wait: true,
        title: { en: 'The totals', ur: 'کل رقم' },
        body: {
          en: 'Income, expenses, salaries and the net for the months chosen.',
          ur: 'چنے گئے مہینوں کی آمدنی، خرچ، تنخواہیں اور خالص۔',
        },
      },
    ],
  },

  {
    id: 'parent-links',
    section: 'parents',
    roles: ['owner', 'admin', 'accountant'],
    title: {
      en: 'Create, renew or revoke a parent link',
      ur: 'والدین کا لنک: بنائیں، نیا کریں، بند کریں',
    },
    summary: {
      en: "Each guardian gets a private link to the family's page. No login.",
      ur: 'ہر سرپرست کو خاندان کے صفحے کا نجی لنک ملتا ہے۔ کوئی لاگ اِن نہیں۔',
    },
    steps: [
      {
        to: '/students',
        text: {
          en: 'Open the student. Under Guardians find **Parent page link**.',
          ur: 'طالب علم کھولیں۔ Guardians کے نیچے **Parent page link** دیکھیں۔',
        },
      },
      {
        text: {
          en: "**Create link**: choose the check before dues (school default, child's birth year, or a PIN), then **Copy link** or **Send via WhatsApp**. It is shown only once.",
          ur: '**Create link**: بقایا دکھانے سے پہلے کی جانچ چنیں (اسکول کی ترتیب، بچے کا سالِ پیدائش، یا PIN)، پھر **Copy link** یا **Send via WhatsApp**۔ لنک صرف ایک بار دکھتا ہے۔',
        },
      },
      {
        text: {
          en: 'Phone lost or link forwarded? **New link**: the old one stops working at once.',
          ur: 'فون گم ہو گیا یا لنک آگے چلا گیا؟ **New link**: پرانا فوراً بند ہو جاتا ہے۔',
        },
      },
      {
        text: {
          en: '**Revoke** turns the link off with no replacement. "Recent visits" shows when it was opened.',
          ur: '**Revoke** لنک بند کر دیتا ہے، نیا نہیں بنتا۔ "Recent visits" بتاتا ہے کب کھولا گیا۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Sending the link in a class WhatsApp group: it is private to one family.',
        ur: 'لنک کلاس کے واٹس ایپ گروپ میں بھیجنا: یہ ایک خاندان کا نجی لنک ہے۔',
      },
      {
        en: 'Looking for an old link later: Maktab does not keep it. Make a **New link**.',
        ur: 'پرانا لنک بعد میں ڈھونڈنا: مکتب اسے محفوظ نہیں رکھتا۔ **New link** بنائیں۔',
      },
    ],
    links: [{ to: '/students', label: { en: 'Students', ur: 'Students' } }],
    tour: [
      {
        path: '/students',
        target: 'students-list',
        title: { en: 'Open the student', ur: 'طالب علم کھولیں' },
        body: {
          en: 'Tap a child of the family. The tour waits for you.',
          ur: 'خاندان کے کسی بچے پر ٹیپ کریں۔ ٹور آپ کا انتظار کرے گا۔',
        },
      },
      {
        path: '/students/:id',
        target: 'parent-link',
        wait: true,
        title: { en: 'Parent page link', ur: 'Parent page link' },
        body: {
          en: '**Create link**, **New link** or **Revoke**, for each guardian.',
          ur: 'ہر سرپرست کے لیے **Create link**، **New link** یا **Revoke**۔',
        },
      },
    ],
  },

  {
    id: 'parent-view',
    section: 'parents',
    roles: ['owner', 'admin', 'accountant', 'teacher'],
    title: { en: 'What parents see', ur: 'والدین کو کیا نظر آتا ہے' },
    summary: {
      en: 'Attendance, dues, receipts and notices, in Urdu or English, with a Listen button.',
      ur: 'حاضری، بقایا، رسیدیں اور نوٹس، اردو یا انگریزی میں، سننے کے بٹن کے ساتھ۔',
    },
    steps: [
      {
        text: {
          en: "The link opens the family's page on the parent's phone, without a login.",
          ur: 'لنک والدین کے فون پر خاندان کا صفحہ کھولتا ہے، بغیر لاگ اِن کے۔',
        },
      },
      {
        text: {
          en: "Anyone with the link sees today's attendance, this month's attendance % and notices.",
          ur: 'لنک والا کوئی بھی آج کی حاضری، اس مہینے کی حاضری کا فیصد اور نوٹس دیکھ سکتا ہے۔',
        },
      },
      {
        text: {
          en: "Dues and receipts first ask a question: by default the birth year of one of the children (or the school's PIN). Five wrong answers lock it for 15 minutes.",
          ur: 'بقایا اور رسیدوں سے پہلے ایک سوال آتا ہے: عام طور پر کسی بچے کا سالِ پیدائش (یا اسکول کا PIN)۔ پانچ غلط جواب پر 15 منٹ کے لیے بند۔',
        },
      },
      {
        text: {
          en: 'The **Listen** button reads the page aloud, for parents who prefer to hear it.',
          ur: '**Listen** کا بٹن صفحہ پڑھ کر سناتا ہے، ان والدین کے لیے جو سننا پسند کریں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Treating the birth-year check as a password: it only slows down a forwarded link.',
        ur: 'سالِ پیدائش کی جانچ کو پاس ورڈ سمجھنا: یہ صرف آگے بھیجے گئے لنک کو روکتی ہے۔',
      },
      {
        en: 'A parent says "That does not match": check the date of birth on the student page.',
        ur: 'والدین کہیں "That does not match": طالب علم کے صفحے پر تاریخ پیدائش دیکھیں۔',
      },
    ],
    links: [],
  },

  {
    id: 'invite-staff',
    section: 'staff',
    roles: ['owner'],
    title: { en: 'Invite staff', ur: 'عملے کو دعوت دیں' },
    summary: {
      en: 'Each person signs in with their own Google email after you invite it.',
      ur: 'دعوت کے بعد ہر شخص اپنے گوگل ای میل سے سائن اِن کرتا ہے۔',
    },
    steps: [
      {
        to: '/settings?section=staff',
        text: {
          en: '**Settings** → **Staff**. In **Invite staff** type the **Google email**, name and role (and the groups for a teacher).',
          ur: '**Settings** → **Staff**۔ **Invite staff** میں **Google email**، نام اور کردار لکھیں (استاد کے لیے گروپ بھی)۔',
        },
      },
      {
        text: {
          en: 'Save. They sign in with that Google account; nobody else can.',
          ur: 'محفوظ کریں۔ وہ اسی گوگل اکاؤنٹ سے سائن اِن کریں گے؛ کوئی اور نہیں کر سکتا۔',
        },
      },
      {
        text: {
          en: 'Staff who never use the app (a guard on the payroll): **Add staff without login**.',
          ur: 'جو عملہ ایپ استعمال نہیں کرتا (تنخواہ والا چوکیدار): **Add staff without login**۔',
        },
      },
      {
        text: {
          en: 'Someone leaves: disable them in the staff list. Their past entries stay.',
          ur: 'کوئی چھوڑ کر جائے: عملے کی فہرست میں بند کر دیں۔ پرانے اندراج محفوظ رہتے ہیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'A typo in the email: "Only staff invited by the school can sign in." Check it letter by letter.',
        ur: 'ای میل میں غلطی: "Only staff invited by the school can sign in." حرف بہ حرف دیکھیں۔',
      },
      {
        en: 'Sharing one account between two people: the audit log cannot tell who did what.',
        ur: 'دو لوگوں کا ایک اکاؤنٹ: آڈٹ لاگ میں پتا نہیں چلتا کس نے کیا کیا۔',
      },
    ],
    links: [{ to: '/settings?section=staff', label: { en: 'Staff', ur: 'Staff' } }],
    tour: [
      {
        path: '/settings',
        target: 'settings-tab-staff',
        click: true,
        title: { en: 'Staff', ur: 'Staff' },
        body: { en: 'Next opens the staff section.', ur: '"آگے" سے عملے کا حصہ کھلے گا۔' },
      },
      {
        path: '/settings',
        target: 'staff-invite',
        wait: true,
        title: { en: 'Invite staff', ur: 'Invite staff' },
        body: {
          en: 'Google email, name, role. They can sign in right after.',
          ur: 'گوگل ای میل، نام، کردار۔ اس کے فوراً بعد سائن اِن کر سکتے ہیں۔',
        },
      },
    ],
  },

  {
    id: 'roles',
    section: 'staff',
    roles: ['owner', 'admin'],
    title: { en: 'Roles: who can do what', ur: 'کردار: کون کیا کر سکتا ہے' },
    summary: {
      en: 'Owner, Admin, Accountant, Teacher. Each sees only their work.',
      ur: 'Owner، Admin، Accountant، Teacher۔ ہر ایک کو صرف اپنا کام نظر آتا ہے۔',
    },
    steps: [
      {
        text: {
          en: '**Owner**: everything, including staff roles, backup and the audit log.',
          ur: '**Owner**: سب کچھ، عملے کے کردار، بیک اپ اور آڈٹ لاگ سمیت۔',
        },
      },
      {
        text: {
          en: '**Admin**: like the owner except roles, backup and the audit log. Bills fees, gives concessions, approves payslips, corrects registers.',
          ur: '**Admin**: مالک جیسا، سوائے کردار، بیک اپ اور آڈٹ لاگ کے۔ فیس بناتا، رعایت دیتا، تنخواہ منظور کرتا، رجسٹر درست کرتا ہے۔',
        },
      },
      {
        text: {
          en: "**Accountant**: students, fee counter, receipts, own cash drawer, expenses, payroll (not the owner's pay), messages. Cannot reverse receipts or bill the month.",
          ur: '**Accountant**: طلبہ، فیس کاؤنٹر، رسیدیں، اپنا کیش دراز، خرچ، تنخواہیں (مالک کی نہیں)، پیغامات۔ رسید واپس یا مہینے کی فیس نہیں بنا سکتا۔',
        },
      },
      {
        text: {
          en: '**Teacher**: own groups only: attendance, those students, absence messages, own payslips. No money.',
          ur: '**Teacher**: صرف اپنے گروپ: حاضری، وہی طلبہ، غیر حاضری کے پیغام، اپنی تنخواہ کی پرچی۔ پیسوں تک رسائی نہیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Making the accountant an admin "to be safe": admins can bill and give concessions.',
        ur: 'احتیاطاً اکاؤنٹنٹ کو ایڈمن بنانا: ایڈمن فیس بنا اور رعایت دے سکتا ہے۔',
      },
      {
        en: 'Nobody approves their own payslip. An owner on the payroll needs a second owner or admin.',
        ur: 'کوئی اپنی تنخواہ خود منظور نہیں کرتا۔ تنخواہ لینے والے مالک کو دوسرا Owner یا Admin چاہیے۔',
      },
    ],
    links: [{ to: '/settings?section=staff', label: { en: 'Staff', ur: 'Staff' } }],
  },

  {
    id: 'payslips',
    section: 'staff',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Payslips', ur: 'تنخواہ کی پرچیاں' },
    summary: {
      en: 'Prepare, check, approve, pay, print. Once a month.',
      ur: 'تیار کریں، دیکھیں، منظور کریں، ادا کریں، پرنٹ کریں۔ مہینے میں ایک بار۔',
    },
    steps: [
      {
        to: '/salary',
        text: {
          en: '**Payroll**: choose the month and press **Prepare payslips**.',
          ur: '**Payroll**: مہینہ چنیں اور **Prepare payslips** دبائیں۔',
        },
      },
      {
        text: {
          en: 'Open each slip and check the lines: allowances, deductions, advance recovery.',
          ur: 'ہر پرچی کھول کر لائنیں دیکھیں: الاؤنس، کٹوتی، ایڈوانس کی واپسی۔',
        },
      },
      {
        text: {
          en: '**Approve** (owner or admin, never your own slip). Then **Pay**: amount and the account it is paid from.',
          ur: '**Approve** (مالک یا ایڈمن، اپنی پرچی کبھی نہیں)۔ پھر **Pay**: رقم اور جس اکاؤنٹ سے دی۔',
        },
      },
      {
        text: {
          en: '**Print slip** for the staff member. Teachers see their own under **My payslips**.',
          ur: 'ملازم کے لیے **Print slip**۔ اساتذہ اپنی پرچی **My payslips** میں دیکھتے ہیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Paying salary as an expense: use **Pay** on the slip, so the salary register stays right.',
        ur: 'تنخواہ کو خرچ میں لکھنا: پرچی پر **Pay** استعمال کریں تاکہ تنخواہ رجسٹر درست رہے۔',
      },
      {
        en: 'Lines are frozen once approved: check before you approve.',
        ur: 'منظوری کے بعد لائنیں نہیں بدلتیں: پہلے دیکھ لیں۔',
      },
    ],
    links: [
      { to: '/salary', label: { en: 'Payroll', ur: 'Payroll' } },
      { to: '/advances', label: { en: 'Advances', ur: 'Advances' } },
    ],
    tour: [
      {
        path: '/salary',
        target: 'salary-month',
        title: { en: 'The month', ur: 'مہینہ' },
        body: { en: 'Pick the month to pay.', ur: 'جس مہینے کی تنخواہ دینی ہے وہ چنیں۔' },
      },
      {
        path: '/salary',
        target: 'salary-prepare',
        title: { en: 'Prepare payslips', ur: 'Prepare payslips' },
        body: {
          en: 'Makes a draft slip for every paid staff member. Safe to press again.',
          ur: 'ہر ملازم کی کچی پرچی بنا دیتا ہے۔ دوبارہ دبانا محفوظ ہے۔',
        },
      },
    ],
  },

  {
    id: 'my-payslips',
    section: 'staff',
    roles: ['teacher'],
    title: { en: 'My payslips', ur: 'میری تنخواہ کی پرچیاں' },
    summary: {
      en: 'Your own approved slips, to view and print.',
      ur: 'آپ کی اپنی منظور شدہ پرچیاں، دیکھنے اور پرنٹ کے لیے۔',
    },
    steps: [
      {
        to: '/my/payslips',
        text: {
          en: 'Open **My payslips** from the menu (on the phone: **More**).',
          ur: 'مینو سے **My payslips** کھولیں (فون پر: **More**)۔',
        },
      },
      {
        text: {
          en: 'Tap a month to see the lines, then **Print slip** if you need paper.',
          ur: 'کسی مہینے پر ٹیپ کر کے لائنیں دیکھیں، کاغذ چاہیے تو **Print slip**۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'A month is missing: it is not approved yet. Ask the office.',
        ur: 'کوئی مہینہ نظر نہیں آ رہا: ابھی منظور نہیں ہوا۔ دفتر سے پوچھیں۔',
      },
    ],
    links: [{ to: '/my/payslips', label: { en: 'My payslips', ur: 'My payslips' } }],
  },

  {
    id: 'backups',
    section: 'safe',
    roles: ['owner'],
    title: { en: 'Backups', ur: 'بیک اپ' },
    summary: {
      en: 'An encrypted copy every night, in two places. Check that it ran.',
      ur: 'ہر رات دو جگہ خفیہ کاپی۔ دیکھتے رہیں کہ بنی یا نہیں۔',
    },
    steps: [
      {
        to: '/settings?section=backup',
        text: {
          en: '**Settings** → **Backup** → **Nightly backup** shows the last run (OK / Partial / Failed), its size and copies.',
          ur: '**Settings** → **Backup** → **Nightly backup** میں آخری بیک اپ (OK / Partial / Failed)، سائز اور کاپیاں نظر آتی ہیں۔',
        },
      },
      {
        text: {
          en: 'It runs every night at 02:30 Pakistan time. Failed, or an alarm that backups have not run: tell the maintainer the same day.',
          ur: 'یہ ہر رات 02:30 (پاکستانی وقت) چلتا ہے۔ Failed ہو یا الارم آئے کہ بیک اپ نہیں بنا: اسی دن مینٹینر کو بتائیں۔',
        },
      },
      {
        text: {
          en: 'A wrong change noticed within 7 days can be undone by the maintainer; everything entered after that minute is typed in again from paper.',
          ur: '7 دن کے اندر پکڑی گئی غلطی مینٹینر واپس کر سکتا ہے؛ اس منٹ کے بعد کا سب کچھ کاغذ سے دوبارہ لکھنا ہو گا۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Ignoring the red banner on Home: it means the backup did not run.',
        ur: 'ہوم پر سرخ پٹی کو نظر انداز کرنا: اس کا مطلب بیک اپ نہیں بنا۔',
      },
      {
        en: 'Losing the backup key: the key is held by two trustees. Without it, no backup can be opened.',
        ur: 'بیک اپ کی چابی کھو دینا: چابی دو امانت داروں کے پاس ہے۔ اس کے بغیر کوئی بیک اپ نہیں کھلتا۔',
      },
    ],
    links: [{ to: '/settings?section=backup', label: { en: 'Backup', ur: 'Backup' } }],
    tour: [
      {
        path: '/settings',
        target: 'settings-tab-backup',
        click: true,
        title: { en: 'Backup', ur: 'Backup' },
        body: { en: 'Next opens the backup section.', ur: '"آگے" سے بیک اپ کا حصہ کھلے گا۔' },
      },
      {
        path: '/settings',
        target: 'backup-status',
        wait: true,
        title: { en: 'Nightly backup', ur: 'Nightly backup' },
        body: {
          en: 'The last run and where the copies are. OK is what you want to see.',
          ur: 'آخری بیک اپ اور کاپیاں کہاں ہیں۔ OK نظر آنا چاہیے۔',
        },
      },
      {
        path: '/settings',
        target: 'backup-drill',
        title: { en: 'Restore drill', ur: 'Restore drill' },
        body: {
          en: 'Once a term, with the maintainer. Record it here.',
          ur: 'ہر ٹرم میں ایک بار، مینٹینر کے ساتھ۔ یہاں درج کریں۔',
        },
      },
    ],
  },

  {
    id: 'restore-drill',
    section: 'safe',
    roles: ['owner'],
    title: { en: 'Restore drill', ur: 'ریسٹور کی مشق' },
    summary: {
      en: 'Once a term, prove the backup opens. Takes about an hour with the maintainer.',
      ur: 'ہر ٹرم ایک بار ثابت کریں کہ بیک اپ کھلتا ہے۔ مینٹینر کے ساتھ تقریباً ایک گھنٹہ۔',
    },
    steps: [
      {
        text: {
          en: 'Agree a time with the maintainer and one key trustee.',
          ur: 'مینٹینر اور چابی کے ایک امانت دار کے ساتھ وقت طے کریں۔',
        },
      },
      {
        text: {
          en: "The maintainer restores last night's backup into a test copy. You check a few things you know: a family's dues, last week's receipts, a register.",
          ur: 'مینٹینر کل رات کا بیک اپ ایک ٹیسٹ کاپی میں کھولتا ہے۔ آپ چند معلوم چیزیں دیکھیں: کسی خاندان کا بقایا، پچھلے ہفتے کی رسیدیں، کوئی رجسٹر۔',
        },
      },
      {
        to: '/settings?section=backup',
        text: {
          en: '**Settings** → **Backup** → **Restore drill (once a term)**: tick the steps, add a note, **Record drill**.',
          ur: '**Settings** → **Backup** → **Restore drill (once a term)**: قدموں پر نشان لگائیں، نوٹ لکھیں، **Record drill**۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Skipping the drill because backups say OK: a backup nobody has opened is a guess.',
        ur: 'بیک اپ OK دیکھ کر مشق چھوڑ دینا: جو بیک اپ کبھی کھولا نہ گیا وہ صرف اندازہ ہے۔',
      },
    ],
    links: [{ to: '/settings?section=backup', label: { en: 'Backup', ur: 'Backup' } }],
  },

  {
    id: 'download-everything',
    section: 'safe',
    roles: ['owner'],
    title: { en: 'Download everything', ur: 'سب کچھ ڈاؤن لوڈ کریں' },
    summary: {
      en: "Your own copy of all the school's data, once a month.",
      ur: 'اسکول کے سارے ڈیٹا کی اپنی کاپی، مہینے میں ایک بار۔',
    },
    steps: [
      {
        to: '/settings?section=backup',
        text: {
          en: '**Settings** → **Backup** → **Download everything**. Keep the page open until it says Saved.',
          ur: '**Settings** → **Backup** → **Download everything**۔ Saved آنے تک صفحہ کھلا رکھیں۔',
        },
      },
      {
        text: {
          en: 'You get one ZIP: a CSV file for every table (opens in Excel), the database structure and a README.',
          ur: 'ایک ZIP ملے گی: ہر ٹیبل کی CSV فائل (Excel میں کھلتی ہے)، ڈیٹابیس کا ڈھانچہ اور README۔',
        },
      },
      {
        text: {
          en: 'Keep it on a USB or a private drive, not in WhatsApp: it holds every family, phone number and CNIC.',
          ur: 'اسے USB یا نجی ڈرائیو میں رکھیں، واٹس ایپ میں نہیں: اس میں ہر خاندان، فون نمبر اور CNIC ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Closing the tab while it prepares: the download stops. Start again.',
        ur: 'تیاری کے دوران ٹیب بند کرنا: ڈاؤن لوڈ رک جاتا ہے۔ دوبارہ شروع کریں۔',
      },
    ],
    links: [{ to: '/settings?section=backup', label: { en: 'Backup', ur: 'Backup' } }],
    tour: [
      {
        path: '/settings',
        target: 'settings-tab-backup',
        click: true,
        title: { en: 'Backup', ur: 'Backup' },
        body: { en: 'Next opens the backup section.', ur: '"آگے" سے بیک اپ کا حصہ کھلے گا۔' },
      },
      {
        path: '/settings',
        target: 'backup-everything',
        wait: true,
        title: { en: 'Download everything', ur: 'Download everything' },
        body: {
          en: 'One ZIP with all the data. Keep it somewhere private.',
          ur: 'سارا ڈیٹا ایک ZIP میں۔ کسی نجی جگہ رکھیں۔',
        },
      },
    ],
  },

  {
    id: 'install-app',
    section: 'phone',
    roles: ['owner', 'admin', 'accountant', 'teacher'],
    title: { en: 'Install the app on the phone', ur: 'فون پر ایپ انسٹال کریں' },
    summary: {
      en: 'Opens like an app from the home screen, and works without internet.',
      ur: 'ہوم اسکرین سے ایپ کی طرح کھلتی ہے، اور انٹرنیٹ کے بغیر بھی چلتی ہے۔',
    },
    steps: [
      {
        text: {
          en: 'Open Maktab in Chrome on the phone and sign in.',
          ur: 'فون پر Chrome میں مکتب کھولیں اور سائن اِن کریں۔',
        },
      },
      {
        text: {
          en: 'When the banner "Install Maktab on this phone" shows, tap **Install**. No banner? Chrome menu (⋮) → **Add to Home screen** or **Install app**.',
          ur: 'جب "Install Maktab on this phone" کی پٹی آئے تو **Install** دبائیں۔ پٹی نہیں آئی؟ Chrome مینو (⋮) → **Add to Home screen** یا **Install app**۔',
        },
      },
      {
        text: {
          en: 'From now on open Maktab from the home-screen icon.',
          ur: 'اب سے مکتب ہوم اسکرین کے آئیکن سے کھولیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Opening Maktab from an old WhatsApp link every day: use the icon, it is faster and works offline.',
        ur: 'ہر روز پرانے واٹس ایپ لنک سے کھولنا: آئیکن استعمال کریں، تیز ہے اور بغیر انٹرنیٹ چلتا ہے۔',
      },
    ],
    links: [],
  },

  {
    id: 'offline',
    section: 'phone',
    roles: ['owner', 'admin', 'accountant', 'teacher'],
    title: { en: 'Working without internet', ur: 'انٹرنیٹ کے بغیر کام' },
    summary: {
      en: 'Registers save on the phone and go when the internet is back. Money needs the internet.',
      ur: 'حاضری فون میں محفوظ ہو کر انٹرنیٹ آنے پر چلی جاتی ہے۔ پیسوں کے کام کے لیے انٹرنیٹ ضروری ہے۔',
    },
    steps: [
      {
        text: {
          en: 'Open the app and each class register once while online; then they also open offline.',
          ur: 'انٹرنیٹ ہوتے ہوئے ایپ اور ہر کلاس کا رجسٹر ایک بار کھول لیں؛ پھر یہ بغیر انٹرنیٹ بھی کھلیں گے۔',
        },
      },
      {
        text: {
          en: 'Offline, **Save attendance** still works: "Saved on this phone". The top bar shows how many are waiting.',
          ur: 'بغیر انٹرنیٹ بھی **Save attendance** کام کرتا ہے: "Saved on this phone"۔ اوپر کی پٹی بتاتی ہے کتنے باقی ہیں۔',
        },
      },
      {
        text: {
          en: 'When the phone is online again, open the app: waiting registers are sent by themselves.',
          ur: 'فون دوبارہ آن لائن ہو تو ایپ کھولیں: باقی رجسٹر خود چلے جاتے ہیں۔',
        },
      },
      {
        text: {
          en: 'The fee counter shows the family offline but cannot issue a receipt until you are back online.',
          ur: 'فیس کاؤنٹر بغیر انٹرنیٹ خاندان دکھاتا ہے، مگر رسید انٹرنیٹ آنے پر ہی بنتی ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Signing out with registers waiting: Maktab warns you. Wait for the internet first.',
        ur: 'باقی رجسٹر کے ساتھ سائن آؤٹ: مکتب خبردار کرتا ہے۔ پہلے انٹرنیٹ کا انتظار کریں۔',
      },
      {
        en: "Clearing Chrome's data with registers waiting: they are lost.",
        ur: 'باقی رجسٹر کے ہوتے Chrome کا ڈیٹا صاف کرنا: وہ ضائع ہو جاتے ہیں۔',
      },
    ],
    links: [{ to: '/attendance', label: { en: 'Attendance', ur: 'Attendance' } }],
  },

  {
    id: 'printing',
    section: 'phone',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Printing receipts (thermal and A5)', ur: 'رسید پرنٹ (تھرمل اور A5)' },
    summary: {
      en: 'Choose the paper on the receipt screen, then Print. Each fits one page.',
      ur: 'رسید کی اسکرین پر کاغذ چنیں، پھر Print۔ ہر رسید ایک صفحے پر۔',
    },
    steps: [
      {
        text: {
          en: 'On the receipt: **58 mm** for a thermal printer, **A5** for a normal printer.',
          ur: 'رسید پر: تھرمل پرنٹر کے لیے **58 mm**، عام پرنٹر کے لیے **A5**۔',
        },
      },
      {
        text: {
          en: 'Choose the **Receipt language** (English or Urdu), then **Print**.',
          ur: '**Receipt language** چنیں (انگریزی یا اردو)، پھر **Print**۔',
        },
      },
      {
        text: {
          en: "In Chrome's print window pick the printer, or **Save as PDF** to send the receipt as a file.",
          ur: 'Chrome کی پرنٹ ونڈو میں پرنٹر چنیں، یا رسید فائل کی شکل میں بھیجنے کے لیے **Save as PDF**۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Margins set to "Default" on a thermal printer cut the sides: choose "None".',
        ur: 'تھرمل پرنٹر پر مارجن "Default" سے کنارے کٹ جاتے ہیں: "None" چنیں۔',
      },
      {
        en: 'Printing twice for a copy is fine; issuing a second receipt is not.',
        ur: 'کاپی کے لیے دوبارہ پرنٹ ٹھیک ہے؛ دوسری رسید جاری کرنا نہیں۔',
      },
    ],
    links: [{ to: '/fees/counter', label: { en: 'Fee counter', ur: 'Fee counter' } }],
  },

  {
    id: 'whatsapp',
    section: 'phone',
    roles: ['owner', 'admin', 'accountant', 'teacher'],
    title: { en: 'Handing off to WhatsApp', ur: 'واٹس ایپ پر بھیجنا' },
    summary: {
      en: 'Maktab prepares; WhatsApp sends; you come back and tap Sent.',
      ur: 'مکتب تیار کرتا ہے؛ واٹس ایپ بھیجتا ہے؛ آپ واپس آ کر Sent دباتے ہیں۔',
    },
    steps: [
      {
        text: {
          en: "Use the school's WhatsApp number on the phone you send from (WhatsApp Business is fine).",
          ur: 'جس فون سے بھیجنا ہے اس پر اسکول کا واٹس ایپ نمبر ہو (WhatsApp Business بھی ٹھیک ہے)۔',
        },
      },
      {
        text: {
          en: "**Open WhatsApp** opens the right chat with the text ready, in the guardian's language. Press send in WhatsApp.",
          ur: '**Open WhatsApp** درست چیٹ میں سرپرست کی زبان میں پیغام تیار کھول دیتا ہے۔ واٹس ایپ میں بھیج دیں۔',
        },
      },
      {
        text: {
          en: 'Come back with the back button; Maktab is still where you left it. Tap **Sent & next**.',
          ur: 'بیک بٹن سے واپس آئیں؛ مکتب وہیں کھلا ملے گا۔ **Sent & next** دبائیں۔',
        },
      },
      {
        text: {
          en: 'Class WhatsApp groups: **Copy all texts for this class** (absence and notice texts only; fee texts are private).',
          ur: 'کلاس کے واٹس ایپ گروپ: **Copy all texts for this class** (صرف غیر حاضری اور نوٹس؛ فیس کے پیغام نجی ہیں)۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Editing away the link at the end of the text: the parent cannot open their page.',
        ur: 'پیغام کے آخر سے لنک ہٹا دینا: والدین اپنا صفحہ نہیں کھول سکتے۔',
      },
      {
        en: 'Pop-up blocked: tap **Open WhatsApp** again, or allow pop-ups for Maktab.',
        ur: 'پاپ اپ بند ہو گیا: دوبارہ **Open WhatsApp** دبائیں، یا مکتب کے لیے پاپ اپ کی اجازت دیں۔',
      },
    ],
    links: [{ to: '/messages', label: { en: 'Messages', ur: 'Messages' } }],
  },
];
